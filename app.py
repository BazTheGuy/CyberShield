import os
import sys
import time
import socket
import sqlite3
import ctypes
import subprocess
import threading
import webview
import http.server
import socketserver
from concurrent.futures import ThreadPoolExecutor
import pystray
from PIL import Image

# Configuration
def get_appdata_dir():
    """Get absolute path to persistent appdata directory for CyberShield."""
    appdata = os.environ.get('APPDATA')
    if appdata:
        dir_path = os.path.join(appdata, 'CyberShield')
    else:
        dir_path = os.path.join(os.path.expanduser('~'), '.cybershield')
    os.makedirs(dir_path, exist_ok=True)
    return dir_path

APPDATA_DIR = get_appdata_dir()
DB_PATH = os.path.join(APPDATA_DIR, 'traffic_history.db')
PRUNE_DAYS = 7
FLUSH_INTERVAL_SEC = 5
POLL_INTERVAL_SEC = 1

# Global caches and variables
traffic_lock = threading.Lock()
# pid -> { 'name', 'path', 'sent_bytes', 'recv_bytes', 'last_io_time', 'speed_sent', 'speed_recv', 'connections' }
process_metrics = {}
# process_name -> { 'sent_accumulated', 'recv_accumulated', 'path' }
db_buffer = {}
# (process_name, remote_host, port, protocol) -> { 'sent', 'recv' }
conn_db_buffer = {}
# Set of process executable paths that are firewalled
blocked_paths = set()
# Set of (process_name, remote_address) seen in telemetry
seen_connections = set()
# Cache for resolved hostnames
dns_cache = {}
dns_executor = ThreadPoolExecutor(max_workers=10)

def is_admin():
    """Check if the process is running with administrator privileges."""
    try:
        return ctypes.windll.shell32.IsUserAnAdmin() != 0
    except Exception:
        return False

def get_asset_path(relative_path):
    """Get absolute path to resource, works for dev and for PyInstaller."""
    if hasattr(sys, '_MEIPASS'):
        return os.path.join(sys._MEIPASS, relative_path)
    return os.path.join(os.path.abspath("."), relative_path)

def init_db():
    """Initialize the SQLite database and create tables."""
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    # 1. Process traffic history
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS traffic_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp INTEGER NOT NULL,
            process_name TEXT NOT NULL,
            exe_path TEXT,
            bytes_sent INTEGER DEFAULT 0,
            bytes_recv INTEGER DEFAULT 0
        )
    ''')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_timestamp ON traffic_history(timestamp)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_procname ON traffic_history(process_name)')
    
    # 2. Connection breakdown history
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS connection_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp INTEGER NOT NULL,
            process_name TEXT NOT NULL,
            remote_host TEXT NOT NULL,
            port INTEGER NOT NULL,
            protocol TEXT NOT NULL,
            bytes_sent INTEGER DEFAULT 0,
            bytes_recv INTEGER DEFAULT 0
        )
    ''')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_conn_timestamp ON connection_history(timestamp)')
    
    # 3. Connection alerts
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS alerts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp INTEGER NOT NULL,
            process_name TEXT NOT NULL,
            remote_address TEXT NOT NULL,
            alert_type TEXT NOT NULL
        )
    ''')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_alerts_timestamp ON alerts(timestamp)')
    
    # 4. Seen connections cache
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS seen_connections (
            process_name TEXT NOT NULL,
            remote_address TEXT NOT NULL,
            PRIMARY KEY (process_name, remote_address)
        )
    ''')
    
    # Load seen connections into memory cache
    cursor.execute('SELECT process_name, remote_address FROM seen_connections')
    for row in cursor.fetchall():
        seen_connections.add((row[0], row[1]))
        
    conn.commit()
    conn.close()

def load_firewall_rules():
    """Load blocked executable paths from Windows Defender Firewall rules."""
    global blocked_paths
    if not is_admin():
        print("[WARNING] Not running as Admin. Existing firewall rules could not be synchronized.")
        return

    try:
        cmd_program = 'powershell -Command "Get-NetFirewallRule -DisplayName \'CyberFirewall - *\' -ErrorAction SilentlyContinue | Get-NetFirewallApplicationFilter | Select-Object -ExpandProperty Program"'
        res_program = subprocess.run(cmd_program, capture_output=True, text=True, shell=True)
        temp_blocked = set()
        if res_program.returncode == 0 and res_program.stdout:
            paths = res_program.stdout.strip().split('\n')
            for p in paths:
                path_str = p.strip()
                if path_str:
                    temp_blocked.add(os.path.normpath(path_str).lower())
            
            with traffic_lock:
                blocked_paths = temp_blocked
            print(f"[INFO] Loaded {len(blocked_paths)} firewall rules: {list(blocked_paths)}")
    except Exception as e:
        print(f"[ERROR] Failed to load firewall rules: {e}")

def add_firewall_rule(name, path):
    """Add Windows Defender Firewall block rules for the program path."""
    if not is_admin():
        return False, "Administrator privileges required."
    
    # Sanitize and normalize path/name to prevent shell command injection
    name = name.replace('"', '').replace("'", "").strip()
    path = os.path.normpath(path).replace('"', '').replace("'", "").strip()
    
    if path.lower() in blocked_paths:
        return True, "Already blocked."
    
    try:
        rule_name_out = f"CyberFirewall - {name}"
        rule_name_in = f"CyberFirewall - {name} (Inbound)"
        
        cmd_out = f'netsh advfirewall firewall add rule name="{rule_name_out}" dir=out program="{path}" action=block enable=yes'
        cmd_in = f'netsh advfirewall firewall add rule name="{rule_name_in}" dir=in program="{path}" action=block enable=yes'
        
        res_out = subprocess.run(cmd_out, capture_output=True, text=True, shell=True)
        res_in = subprocess.run(cmd_in, capture_output=True, text=True, shell=True)
        
        if res_out.returncode == 0 and res_in.returncode == 0:
            with traffic_lock:
                blocked_paths.add(path.lower())
            print(f"[INFO] Blocked application: {name} at {path}")
            return True, "Blocked successfully."
        else:
            err_msg = res_out.stderr or res_in.stderr
            return False, f"Firewall rule creation failed: {err_msg}"
    except Exception as e:
        return False, str(e)

def remove_firewall_rule(name, path):
    """Remove Windows Defender Firewall block rules for the program path."""
    if not is_admin():
        return False, "Administrator privileges required."
    
    # Sanitize and normalize path/name to prevent shell command injection
    name = name.replace('"', '').replace("'", "").strip()
    path = os.path.normpath(path).replace('"', '').replace("'", "").strip()
    
    try:
        rule_name_out = f"CyberFirewall - {name}"
        rule_name_in = f"CyberFirewall - {name} (Inbound)"
        
        cmd_out = f'netsh advfirewall firewall delete rule name="{rule_name_out}"'
        cmd_in = f'netsh advfirewall firewall delete rule name="{rule_name_in}"'
        
        subprocess.run(cmd_out, shell=True, capture_output=True)
        subprocess.run(cmd_in, shell=True, capture_output=True)
        
        with traffic_lock:
            if path.lower() in blocked_paths:
                blocked_paths.remove(path.lower())
        print(f"[INFO] Unblocked application: {name} at {path}")
        return True, "Unblocked successfully."
    except Exception as e:
        return False, str(e)

import psutil

# Queues for database flushing
alerts_queue = []
seen_queue = []
seen_processes = set()

def init_seen_processes():
    global seen_processes
    # 1. Add all process names from history database
    try:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        cursor.execute('SELECT DISTINCT process_name FROM traffic_history')
        for row in cursor.fetchall():
            seen_processes.add(row[0].lower())
        conn.close()
    except Exception:
        pass
        
    # 2. Add all currently active running process names
    try:
        for proc in psutil.process_iter(['name']):
            try:
                name = proc.info['name']
                if name:
                    seen_processes.add(name.lower())
            except Exception:
                pass
    except Exception:
        pass
    print(f"[INFO] Initialized seen_processes cache with {len(seen_processes)} entries.")

def trigger_realtime_stream_log(process_name, remote_ip):
    # Resolve hostname in a daemon thread so it doesn't block the telemetry loop
    def run():
        try:
            resolved_host = get_resolved_hostname(remote_ip)
            global window
            if window:
                try:
                    import json
                    window.evaluate_js(f"appendRealtimeAlertLog({json.dumps(process_name)}, {json.dumps(resolved_host)});")
                except Exception:
                    pass
        except Exception:
            pass
    threading.Thread(target=run, daemon=True).start()

def trigger_alert_notifications(process_name, remote_ip):
    # Resolve hostname in a daemon thread so it doesn't block the telemetry loop
    def run():
        try:
            resolved_host = get_resolved_hostname(remote_ip)
            # 1. System Tray Notification
            global tray_icon
            if tray_icon:
                try:
                    msg = f"{process_name} connected to {resolved_host}"
                    tray_icon.notify(msg, "New Connection Detected")
                except Exception:
                    pass
            # 2. In-App Front-End Toast
            global window
            if window:
                try:
                    import json
                    window.evaluate_js(f"showConnectionToast({json.dumps(process_name)}, {json.dumps(resolved_host)});")
                except Exception:
                    pass
        except Exception:
            pass
    threading.Thread(target=run, daemon=True).start()

def poll_telemetry():
    """Background loop that polls active process connections and calculates real network speeds."""
    global process_metrics, db_buffer, conn_db_buffer, seen_connections, alerts_queue, seen_queue
    
    # Track system-wide network interface counters for delta calculations
    try:
        last_sys_net = psutil.net_io_counters()
    except Exception:
        last_sys_net = None
        
    last_flush_time = time.time()
    
    while True:
        try:
            start_time = time.time()
            
            # 1. Fetch system-wide network deltas
            sys_recv_delta = 0
            sys_sent_delta = 0
            try:
                current_sys_net = psutil.net_io_counters()
                if last_sys_net:
                    sys_recv_delta = max(0, current_sys_net.bytes_recv - last_sys_net.bytes_recv)
                    sys_sent_delta = max(0, current_sys_net.bytes_sent - last_sys_net.bytes_sent)
                last_sys_net = current_sys_net
            except Exception:
                pass
                
            # 2. Get active connection mappings
            connections = []
            try:
                connections = psutil.net_connections(kind='inet')
            except Exception:
                pass
            
            pid_connections = {}
            for conn in connections:
                if conn.pid is None or conn.pid == 0:
                    continue
                
                raddr = ""
                if conn.raddr:
                    raddr = f"{conn.raddr.ip}:{conn.raddr.port}"
                
                laddr = f"{conn.laddr.ip}:{conn.laddr.port}"
                
                conn_info = {
                    'local': laddr,
                    'remote': raddr,
                    'status': conn.status,
                    'type': 'TCP' if conn.type == 1 else 'UDP'
                }
                
                if conn.pid not in pid_connections:
                    pid_connections[conn.pid] = []
                pid_connections[conn.pid].append(conn_info)
            
            # 3. Collect active network process metrics
            candidates = []
            for pid, conns in pid_connections.items():
                try:
                    proc = psutil.Process(pid)
                    name = proc.name()
                    try:
                        exe_path = proc.exe()
                    except Exception:
                        exe_path = ""
                    try:
                        io = proc.io_counters()
                        read_bytes = io.read_bytes
                        write_bytes = io.write_bytes
                    except Exception:
                        read_bytes = 0
                        write_bytes = 0
                        
                    candidates.append({
                        'pid': pid,
                        'name': name,
                        'path': exe_path,
                        'read_bytes': read_bytes,
                        'write_bytes': write_bytes,
                        'connections': conns
                    })
                except Exception:
                    continue
            
            # 4. Calculate process disk I/O deltas and assign weights
            total_read_weight = 0
            total_write_weight = 0
            
            for c in candidates:
                pid = c['pid']
                c['delta_read'] = 0
                c['delta_write'] = 0
                if pid in process_metrics:
                    old = process_metrics[pid]
                    c['delta_read'] = max(0, c['read_bytes'] - old['raw_read'])
                    c['delta_write'] = max(0, c['write_bytes'] - old['raw_write'])
                
                # Weight = raw disk I/O delta + 1KB base weight to capture pure socket communication
                c['weight_read'] = c['delta_read'] + 1024
                c['weight_write'] = c['delta_write'] + 1024
                
                total_read_weight += c['weight_read']
                total_write_weight += c['weight_write']
            
            current_time = time.time()
            new_metrics = {}
            
            # 5. Distribute system-wide network bandwidth based on weights
            for c in candidates:
                pid = c['pid']
                allocated_recv = 0
                allocated_sent = 0
                if total_read_weight > 0:
                    allocated_recv = sys_recv_delta * (c['weight_read'] / total_read_weight)
                if total_write_weight > 0:
                    allocated_sent = sys_sent_delta * (c['weight_write'] / total_write_weight)
                
                speed_recv = allocated_recv
                speed_sent = allocated_sent
                
                # Buffer for DB process history
                db_key = (c['name'], c['path'])
                if db_key not in db_buffer:
                    db_buffer[db_key] = {'sent': 0, 'recv': 0}
                db_buffer[db_key]['sent'] += allocated_sent
                db_buffer[db_key]['recv'] += allocated_recv
                
                # Allocate bytes equally to active connection paths and check for alerts
                num_conns = len(c['connections'])
                if num_conns > 0:
                    conn_recv_share = allocated_recv / num_conns
                    conn_sent_share = allocated_sent / num_conns
                    
                    for conn in c['connections']:
                        remote_ip = conn['remote'].split(':')[0] if conn['remote'] else ''
                        if remote_ip:
                            try:
                                port = int(conn['remote'].split(':')[1])
                            except Exception:
                                port = 0
                            protocol = conn['type']
                            
                            # Log connection breakdown in buffer
                            conn_key = (c['name'], remote_ip, port, protocol)
                            if conn_key not in conn_db_buffer:
                                conn_db_buffer[conn_key] = {'sent': 0, 'recv': 0}
                            conn_db_buffer[conn_key]['sent'] += conn_sent_share
                            conn_db_buffer[conn_key]['recv'] += conn_recv_share
                            
                            # Check for new connection alert
                            alert_key = (c['name'], remote_ip)
                            if alert_key not in seen_connections:
                                seen_connections.add(alert_key)
                                seen_queue.append(alert_key)
                                alerts_queue.append((int(current_time), c['name'], remote_ip, 'first_connection'))
                                
                                # ALWAYS append connection discoveries to the frontend realtime alerts scrolling stream log
                                trigger_realtime_stream_log(c['name'], remote_ip)
                                
                                # ONLY trigger notifications for a new application (process name) seen for the first time
                                proc_name_lower = c['name'].lower()
                                if proc_name_lower not in seen_processes:
                                    seen_processes.add(proc_name_lower)
                                    trigger_alert_notifications(c['name'], remote_ip)
                
                new_metrics[pid] = {
                    'name': c['name'],
                    'path': c['path'],
                    'raw_read': c['read_bytes'],
                    'raw_write': c['write_bytes'],
                    'recv_bytes': allocated_recv,
                    'sent_bytes': allocated_sent,
                    'last_io_time': current_time,
                    'speed_sent': speed_sent,
                    'speed_recv': speed_recv,
                    'connections': c['connections']
                }
            
            with traffic_lock:
                process_metrics = new_metrics
            
            # Database flush & cleanup
            if current_time - last_flush_time >= FLUSH_INTERVAL_SEC:
                flush_to_db(int(current_time))
                last_flush_time = current_time
                prune_old_records(int(current_time))
            
            elapsed = time.time() - start_time
            sleep_time = max(0.1, POLL_INTERVAL_SEC - elapsed)
            time.sleep(sleep_time)
            
        except Exception as e:
            print(f"[ERROR] Error in telemetry thread: {e}")
            time.sleep(2)

def flush_to_db(timestamp):
    global db_buffer, conn_db_buffer, alerts_queue, seen_queue
    
    try:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        
        # 1. Flush process traffic history
        if db_buffer:
            insert_data = []
            for (name, path), data in db_buffer.items():
                if data['sent'] > 0 or data['recv'] > 0:
                    insert_data.append((timestamp, name, path, int(data['sent']), int(data['recv'])))
            if insert_data:
                cursor.executemany(
                    'INSERT INTO traffic_history (timestamp, process_name, exe_path, bytes_sent, bytes_recv) VALUES (?, ?, ?, ?, ?)',
                    insert_data
                )
            db_buffer.clear()
            
        # 2. Flush connection breakdown history
        if conn_db_buffer:
            insert_conns = []
            for (name, host, port, proto), data in conn_db_buffer.items():
                if data['sent'] > 0 or data['recv'] > 0:
                    insert_conns.append((timestamp, name, host, port, proto, int(data['sent']), int(data['recv'])))
            if insert_conns:
                cursor.executemany(
                    'INSERT INTO connection_history (timestamp, process_name, remote_host, port, protocol, bytes_sent, bytes_recv) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    insert_conns
                )
            conn_db_buffer.clear()
            
        # 3. Flush seen connections cache table
        if seen_queue:
            cursor.executemany(
                'INSERT OR IGNORE INTO seen_connections (process_name, remote_address) VALUES (?, ?)',
                seen_queue
            )
            seen_queue.clear()
            
        # 4. Flush alerts table
        if alerts_queue:
            cursor.executemany(
                'INSERT INTO alerts (timestamp, process_name, remote_address, alert_type) VALUES (?, ?, ?, ?)',
                alerts_queue
            )
            alerts_queue.clear()
            
        conn.commit()
        conn.close()
    except Exception as e:
        print(f"[ERROR] Failed to flush to database: {e}")

def prune_old_records(current_timestamp):
    try:
        cutoff = current_timestamp - (PRUNE_DAYS * 24 * 60 * 60)
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        cursor.execute('DELETE FROM traffic_history WHERE timestamp < ?', (cutoff,))
        cursor.execute('DELETE FROM connection_history WHERE timestamp < ?', (cutoff,))
        cursor.execute('DELETE FROM alerts WHERE timestamp < ?', (cutoff,))
        conn.commit()
        conn.close()
    except Exception as e:
        print(f"[ERROR] Failed to prune database: {e}")

def get_resolved_hostname(ip):
    if ip in dns_cache:
        return dns_cache[ip]
    
    # Only return loopback as localhost
    if ip.startswith("127.") or ip == "::1" or ip == "0.0.0.0":
        dns_cache[ip] = "localhost"
        return dns_cache[ip]
        
    # Queue DNS resolution in the background and return IP instantly to prevent UI blocking!
    dns_cache[ip] = ip # Temporarily store IP as name so we don't queue multiple requests
    
    def resolve():
        try:
            socket.setdefaulttimeout(1.0)
            hostname = socket.gethostbyaddr(ip)[0]
            dns_cache[ip] = hostname
        except Exception:
            pass
            
    dns_executor.submit(resolve)
    return ip

mac_cache = {}

def get_mac_vendor(mac_address):
    import urllib.request
    import urllib.error
    
    mac_clean = mac_address.upper().replace(':', '-').strip()
    if mac_clean in mac_cache:
        return mac_cache[mac_clean]
        
    # Check for locally administered (private/randomized) MACs
    # If the second hex digit is 2, 6, A, or E, it is a randomized privacy address
    if len(mac_clean) >= 2:
        second_char = mac_clean[1]
        if second_char in ['2', '6', 'A', 'E']:
            res = ("Private / Randomized Node (Mobile/PC)", "mobile")
            mac_cache[mac_clean] = res
            return res
            
    oui = mac_clean[:8].replace('-', ':')
    
    # Highly expanded OUI local database for smart home / networking devices
    vendor_db = {
        '00:11:32': ('Synology NAS', 'pc'),
        '00:17:88': ('Philips Hue Hub', 'iot'),
        '70:EE:50': ('Philips Hue Hub', 'iot'),
        'D8:EC:5E': ('Philips Hue Hub', 'iot'),
        '18:B4:30': ('Nest Labs Smart Home', 'iot'),
        '2C:3A:E8': ('Espressif IoT System', 'iot'),
        'B4:75:0E': ('Raspberry Pi', 'iot'),
        'B8:27:EB': ('Raspberry Pi Controller', 'iot'),
        'DC:A6:32': ('Raspberry Pi', 'iot'),
        'E4:5F:01': ('Raspberry Pi', 'iot'),
        '44:65:0D': ('Amazon Echo / Fire TV', 'iot'),
        '50:DC:E7': ('Amazon Echo / Fire TV', 'iot'),
        'E8:DB:84': ('Apple Device', 'mobile'),
        '94:10:3F': ('Apple Device', 'mobile'),
        '28:39:5E': ('Apple Device', 'mobile'),
        '84:17:15': ('Google Home Node', 'iot'),
        'B0:D0:9C': ('Google Chromecast', 'iot'),
        'D8:B3:77': ('HP Smart Printer', 'network'),
        '00:24:D7': ('Intel PC Card', 'pc'),
        '60:57:18': ('Intel Wireless Card', 'pc'),
        'D4:A3:3D': ('Samsung Smart TV / Phone', 'mobile'),
        '58:24:29': ('Tesla Smart Car', 'iot'),
        '70:5A:0F': ('TP-Link Device', 'iot'),
        'C8:3A:35': ('TP-Link Device', 'iot'),
        '38:06:E6': ('TP-Link Device', 'iot'),
        'C8:2E:18': ('TP-Link Device', 'iot'),
        'FC:B9:7E': ('Apple Device', 'mobile'),
        '00:0C:29': ('VMware Virtual Machine', 'pc'),
        '00:50:56': ('VMware Server Interface', 'pc')
    }
    
    if oui in vendor_db:
        res = vendor_db[oui]
        mac_cache[mac_clean] = res
        return res
        
    # Public API query fallback
    try:
        url = f"https://api.macvendors.com/{mac_clean}"
        req = urllib.request.Request(
            url, 
            headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}
        )
        # Crucial 1-second timeout to prevent scanning threads from blocking
        with urllib.request.urlopen(req, timeout=1.0) as response:
            vendor_name = response.read().decode('utf-8').strip()
            
            # Smart node type classification heuristic based on vendor names
            vendor_lower = vendor_name.lower()
            node_type = "generic"
            
            if any(x in vendor_lower for x in ["apple", "samsung", "huawei", "xiaomi", "motorola", "oneplus"]):
                node_type = "mobile"
            elif any(x in vendor_lower for x in ["tp-link", "cisco", "netgear", "asus", "linksys", "ubiquiti", "d-link", "synology"]):
                node_type = "network"
            elif any(x in vendor_lower for x in ["hewlett", "epson", "canon", "brother", "xerox", "lexmark"]):
                node_type = "network"
            elif any(x in vendor_lower for x in ["intel", "dell", "lenovo", "microsoft", "gigabyte", "asustek"]):
                node_type = "pc"
            elif any(x in vendor_lower for x in ["amazon", "nest", "google", "philips", "sonos", "espressif", "roku", "tesla"]):
                node_type = "iot"
                
            res = (vendor_name, node_type)
            mac_cache[mac_clean] = res
            return res
    except Exception:
        pass
        
    # Default fallback
    res = ("Generic Device", "generic")
    mac_cache[mac_clean] = res
    return res


# --- PyWebView API Class ---
class DesktopAPI:
    """Class exposing methods to JS frontend via window.pywebview.api"""
    
    def get_status(self):
        return {
            'admin': is_admin(),
            'os': sys.platform,
            'uptime': int(time.process_time())
        }
        
    def clear_alerts(self):
        try:
            conn = sqlite3.connect(DB_PATH)
            cursor = conn.cursor()
            cursor.execute('DELETE FROM alerts')
            conn.commit()
            conn.close()
            return {'success': True}
        except Exception as e:
            return {'success': False, 'error': str(e)}

    def get_traffic(self):
        aggregated = {}
        with traffic_lock:
            for pid, data in process_metrics.items():
                name = data['name']
                path = data['path']
                path_key = path.lower() if path else name.lower()
                
                is_blocked = path_key in blocked_paths
                
                if path_key not in aggregated:
                    aggregated[path_key] = {
                        'name': name,
                        'path': path,
                        'speed_sent': 0,
                        'speed_recv': 0,
                        'connection_count': 0,
                        'connections': [],
                        'blocked': is_blocked
                    }
                
                aggregated[path_key]['speed_sent'] += data['speed_sent']
                aggregated[path_key]['speed_recv'] += data['speed_recv']
                aggregated[path_key]['connection_count'] += len(data['connections'])
                if len(aggregated[path_key]['connections']) < 50:
                    aggregated[path_key]['connections'].extend(data['connections'])

        result = list(aggregated.values())
        result.sort(key=lambda x: (x['speed_sent'] + x['speed_recv']), reverse=True)
        return result
        
    def toggle_firewall(self, name, path, block):
        if not is_admin():
            return {'success': False, 'error': 'Administrator privileges required.'}
        if not path:
            return {'success': False, 'error': 'Cannot block process with empty path.'}
            
        if block:
            success, msg = add_firewall_rule(name, path)
        else:
            success, msg = remove_firewall_rule(name, path)
        return {'success': success, 'message': msg}
        
    def resolve_ips(self, ips):
        ips = list(set(ips))
        results = {}
        futures = {dns_executor.submit(get_resolved_hostname, ip): ip for ip in ips}
        for future in futures:
            ip = futures[future]
            try:
                results[ip] = future.result()
            except Exception:
                results[ip] = ip
        return results
        
    def get_history(self, start, end):
        try:
            conn = sqlite3.connect(DB_PATH)
            cursor = conn.cursor()
            cursor.execute('''
                SELECT process_name, exe_path, SUM(bytes_sent), SUM(bytes_recv)
                FROM traffic_history
                WHERE timestamp >= ? AND timestamp <= ?
                GROUP BY process_name, exe_path
                ORDER BY (SUM(bytes_sent) + SUM(bytes_recv)) DESC
            ''', (start, end))
            
            rows = cursor.fetchall()
            conn.close()
            
            result = []
            for r in rows:
                name, path, sent, recv = r
                result.append({
                    'name': name,
                    'path': path,
                    'bytes_sent': sent or 0,
                    'bytes_recv': recv or 0,
                    'bytes_total': (sent or 0) + (recv or 0)
                })
            return result
        except Exception as e:
            return {'error': str(e)}
            
    def get_history_timeline(self, start, end):
        try:
            conn = sqlite3.connect(DB_PATH)
            cursor = conn.cursor()
            diff = end - start
            if diff <= 600:
                step = 10
            elif diff <= 7200:
                step = 60
            elif diff <= 100000:
                step = 900
            else:
                step = 7200
                
            cursor.execute('''
                SELECT (timestamp / ?) * ? as bin_time, SUM(bytes_sent), SUM(bytes_recv)
                FROM traffic_history
                WHERE timestamp >= ? AND timestamp <= ?
                GROUP BY bin_time
                ORDER BY bin_time ASC
            ''', (step, step, start, end))
            
            rows = cursor.fetchall()
            conn.close()
            
            result = []
            for r in rows:
                bin_time, sent, recv = r
                result.append({
                    'timestamp': bin_time,
                    'bytes_sent': sent or 0,
                    'bytes_recv': recv or 0
                })
            return result
        except Exception as e:
            return {'error': str(e)}

    def get_blocked_apps(self):
        global blocked_paths
        blocked_list = []
        for path in blocked_paths:
            if path:
                name = os.path.basename(path)
                blocked_list.append({
                    'name': name,
                    'path': path
                })
        return blocked_list

    def get_usage_history(self, start, end):
        try:
            conn = sqlite3.connect(DB_PATH)
            cursor = conn.cursor()
            
            # 1. Total summary
            cursor.execute('''
                SELECT SUM(bytes_recv), SUM(bytes_sent)
                FROM traffic_history
                WHERE timestamp >= ? AND timestamp <= ?
            ''', (start, end))
            summary_row = cursor.fetchone()
            total_recv = summary_row[0] or 0
            total_sent = summary_row[1] or 0
            
            # 2. Apps breakdown
            cursor.execute('''
                SELECT process_name, SUM(bytes_recv), SUM(bytes_sent)
                FROM traffic_history
                WHERE timestamp >= ? AND timestamp <= ?
                GROUP BY process_name
                ORDER BY (SUM(bytes_recv) + SUM(bytes_sent)) DESC
                LIMIT 30
            ''', (start, end))
            apps_rows = cursor.fetchall()
            apps = [{'name': r[0], 'recv': r[1] or 0, 'sent': r[2] or 0, 'bytes': (r[1] or 0) + (r[2] or 0)} for r in apps_rows]
            
            # 3. Hosts breakdown
            cursor.execute('''
                SELECT remote_host, SUM(bytes_recv), SUM(bytes_sent)
                FROM connection_history
                WHERE timestamp >= ? AND timestamp <= ?
                GROUP BY remote_host
                ORDER BY (SUM(bytes_recv) + SUM(bytes_sent)) DESC
                LIMIT 30
            ''', (start, end))
            hosts_rows = cursor.fetchall()
            
            hosts = []
            ips_to_resolve = [r[0] for r in hosts_rows if r[0] and not r[0].startswith('127.') and r[0] != 'localhost']
            
            resolved_names = {}
            for ip in ips_to_resolve:
                resolved_names[ip] = get_resolved_hostname(ip)
            
            for r in hosts_rows:
                ip = r[0]
                display_name = resolved_names.get(ip, ip) if ip else "Unknown Host"
                hosts.append({'name': display_name, 'recv': r[1] or 0, 'sent': r[2] or 0, 'bytes': (r[1] or 0) + (r[2] or 0)})
                
            # 4. Traffic types breakdown
            cursor.execute('''
                SELECT port, protocol, SUM(bytes_recv), SUM(bytes_sent)
                FROM connection_history
                WHERE timestamp >= ? AND timestamp <= ?
                GROUP BY port, protocol
                ORDER BY (SUM(bytes_recv) + SUM(bytes_sent)) DESC
                LIMIT 30
            ''', (start, end))
            traffic_rows = cursor.fetchall()
            
            port_map = {
                80: 'HTTP (Hypertext Transfer Protocol)',
                443: 'HTTPS (Secure Web Traffic)',
                53: 'DNS (Domain Name System)',
                123: 'NTP (Network Time)',
                445: 'SMB (File Sharing)',
                22: 'SSH (Secure Shell)',
                21: 'FTP (File Transfer)',
                1900: 'SSDP (UPnP Discovery)',
                5353: 'mDNS (Multicast DNS)',
                137: 'NetBIOS Name Service',
                138: 'NetBIOS Datagram Service'
            }
            
            traffic = []
            for r in traffic_rows:
                port, proto, recv, sent = r
                label = port_map.get(port, f"Port {port} ({proto})")
                traffic.append({'name': label, 'recv': recv or 0, 'sent': sent or 0, 'bytes': (recv or 0) + (sent or 0)})
                
            conn.close()
            
            return {
                'total_recv': total_recv,
                'total_sent': total_sent,
                'apps': apps,
                'hosts': hosts,
                'traffic': traffic
            }
        except Exception as e:
            return {'error': str(e)}

    def get_alerts(self):
        try:
            conn = sqlite3.connect(DB_PATH)
            cursor = conn.cursor()
            cursor.execute('SELECT id, timestamp, process_name, remote_address, alert_type FROM alerts ORDER BY timestamp DESC LIMIT 100')
            rows = cursor.fetchall()
            conn.close()
            
            ips = list(set(r[3] for r in rows if r[3]))
            resolved = {}
            for ip in ips:
                resolved[ip] = get_resolved_hostname(ip)
                        
            results = []
            for r in rows:
                alert_id, ts, proc, ip, atype = r
                resolved_host = resolved.get(ip, ip)
                results.append({
                    'id': alert_id,
                    'timestamp': ts,
                    'process_name': proc,
                    'remote_host': resolved_host,
                    'type': atype
                })
            return results
        except Exception as e:
            return {'error': str(e)}

    def scan_network(self):
        try:
            import re
            
            # Detect local IP
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            try:
                s.connect(('8.8.8.8', 80))
                local_ip = s.getsockname()[0]
            except Exception:
                local_ip = '127.0.0.1'
            finally:
                s.close()
                
            if local_ip == '127.0.0.1':
                return []
                
            base_ip = '.'.join(local_ip.split('.')[:3]) + '.'
            
            # Lightning-fast UDP sweep to trigger background OS ARP resolution
            def trigger_arp(ip):
                try:
                    s_udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                    s_udp.sendto(b'', (ip, 135))
                    s_udp.close()
                except Exception:
                    pass

            ips_to_sweep = [f"{base_ip}{i}" for i in range(1, 255) if f"{base_ip}{i}" != local_ip]
            
            with ThreadPoolExecutor(max_workers=50) as executor:
                executor.map(trigger_arp, ips_to_sweep)
                
            time.sleep(0.4)
                
            # Run and parse arp -a
            devices = []
            output = subprocess.check_output('arp -a', shell=True, text=True, errors='ignore')
            lines = output.split('\n')
            
            ip_mac_pattern = re.compile(
                r'([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})\s+([0-9a-fA-F-]{17})\s+(\w+)'
            )
            
            # Gather discovered nodes
            discovered_nodes = []
            for line in lines:
                match = ip_mac_pattern.search(line)
                if match:
                    ip, mac, link_type = match.groups()
                    if ip.startswith('224.') or ip.startswith('239.') or ip.endswith('.255') or ip == '255.255.255.255':
                        continue
                    discovered_nodes.append((ip, mac, link_type))
                    
            # Resolve DNS hostnames and MAC vendors in parallel using thread executor
            def resolve_node(node_info):
                ip, mac, link_type = node_info
                mac_norm = mac.upper().replace('-', ':')
                
                # Fetch vendor & node type
                vendor_name, node_type = get_mac_vendor(mac_norm)
                
                # Try to fetch local hostname
                hostname = get_resolved_hostname(ip)
                if hostname != ip:
                    vendor_name = f"{hostname} ({vendor_name})"
                
                if ip == local_ip:
                    vendor_name = "This Computer (Host)"
                    node_type = "pc"
                elif link_type.lower() == 'static' and vendor_name == "Generic Device":
                    vendor_name = "Network Interface / Gateway"
                    node_type = "network"
                    
                return {
                    'ip': ip,
                    'mac': mac_norm,
                    'vendor': vendor_name,
                    'type': node_type
                }
                
            with ThreadPoolExecutor(max_workers=10) as resolver_executor:
                resolved_results = list(resolver_executor.map(resolve_node, discovered_nodes))
                
            # Deduplicate and sort by IP address
            unique_devices = {}
            for d in resolved_results:
                unique_devices[d['ip']] = d
            
            def ip_key(ip_str):
                return [int(x) for x in ip_str.split('.')]
                
            sorted_ips = sorted(unique_devices.keys(), key=ip_key)
            return [unique_devices[ip] for ip in sorted_ips]
            
        except Exception as e:
            return {'error': str(e)}

    def get_startup(self):
        try:
            import subprocess
            result = subprocess.run(
                ['schtasks', '/query', '/tn', 'CyberShieldStartup'],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
            )
            return result.returncode == 0
        except Exception:
            return False

    def toggle_startup(self, enabled):
        try:
            import subprocess
            task_name = 'CyberShieldStartup'
            if enabled:
                exe_path = sys.executable
                if not getattr(sys, 'frozen', False):
                    exe_cmd = f'"{ sys.executable}" "{os.path.abspath(sys.argv[0])}" --minimized'
                else:
                    exe_cmd = f'"{ exe_path}" --minimized'
                # Delete existing task first (ignore errors)
                subprocess.run(
                    ['schtasks', '/delete', '/tn', task_name, '/f'],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
                )
                # Create new task: run at logon with highest privileges
                subprocess.run(
                    ['schtasks', '/create', '/tn', task_name, '/tr', exe_cmd,
                     '/sc', 'onlogon', '/rl', 'highest', '/f'],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    check=True
                )
            else:
                subprocess.run(
                    ['schtasks', '/delete', '/tn', task_name, '/f'],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
                )
            # Also clean up old registry entry if it exists
            try:
                import winreg
                reg_path = r"Software\Microsoft\Windows\CurrentVersion\Run"
                key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, reg_path, 0, winreg.KEY_WRITE)
                try:
                    winreg.DeleteValue(key, "CyberShield")
                except FileNotFoundError:
                    pass
                winreg.CloseKey(key)
            except Exception:
                pass
            return {'success': True}
        except Exception as e:
            return {'success': False, 'error': str(e)}

    def save_settings(self, settings):
        try:
            import json
            settings_path = os.path.join(APPDATA_DIR, 'settings.json')
            with open(settings_path, 'w', encoding='utf-8') as f:
                json.dump(settings, f, indent=4)
            return {'success': True}
        except Exception as e:
            return {'success': False, 'error': str(e)}

    def load_settings(self):
        try:
            import json
            settings_path = os.path.join(APPDATA_DIR, 'settings.json')
            if os.path.exists(settings_path):
                with open(settings_path, 'r', encoding='utf-8') as f:
                    return json.load(f)
            return {}
        except Exception as e:
            return {'error': str(e)}


# Global reference to the webview window and tray icon
window = None
tray_icon = None
_single_instance_mutex = None

def ensure_single_instance():
    """Ensure only one instance of CyberShield runs concurrently using a named system mutex."""
    global _single_instance_mutex
    ERROR_ALREADY_EXISTS = 183
    mutex_name = "Global\\CyberShield_SingleInstance_Mutex_BazLabs"
    try:
        _single_instance_mutex = ctypes.windll.kernel32.CreateMutexW(None, True, mutex_name)
        last_error = ctypes.windll.kernel32.GetLastError()
        if last_error == ERROR_ALREADY_EXISTS:
            print("[INFO] CyberShield is already running. Another instance is active. Exiting.")
            sys.exit(0)
    except Exception as e:
        print("[WARNING] Single instance check failed:", e)

def ensure_admin():
    """Re-launch with UAC elevation if not already running as admin."""
    if not is_admin():
        ctypes.windll.shell32.ShellExecuteW(
            None, 'runas', sys.executable, ' '.join(sys.argv), None, 1
        )
        sys.exit(0)

def on_closing():
    """Intercept window close: hide to tray instead of quitting."""
    global window
    window.hide()
    return False  # Prevents window destruction

def create_tray_icon():
    """Create and return a pystray system tray icon with Show/Quit menu items."""
    global window, tray_icon
    icon_path = get_asset_path('cyber_shield_icon.ico')
    icon_image = Image.open(icon_path)

    def show_window(icon, item):
        window.show()

    def quit_app(icon, item):
        icon.stop()
        window.destroy()
        os._exit(0)

    menu = pystray.Menu(
        pystray.MenuItem('Show CyberShield', show_window, default=True),
        pystray.MenuItem('Quit', quit_app)
    )
    tray_icon = pystray.Icon('CyberShield', icon_image, 'CyberShield', menu)
    return tray_icon

def find_free_port():
    """Find a random open port on localhost."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    return port

def start_local_server(port, directory):
    """Run a basic HTTP server serving the specified directory."""
    class SafeHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=directory, **kwargs)

        def end_headers(self):
            # Prevent caching so pywebview always loads the latest files
            self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
            self.send_header('Pragma', 'no-cache')
            self.send_header('Expires', '0')
            super().end_headers()
            
        def log_message(self, format, *args):
            # Suppress default request logs to prevent console pollution
            pass

    # Allow address reuse
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(('127.0.0.1', port), SafeHTTPRequestHandler) as httpd:
        print(f"[INFO] Local HTTP server running on http://127.0.0.1:{port} serving {directory}")
        httpd.serve_forever()


if __name__ == '__main__':
    # Parse CLI flags (retaining test support)
    if len(sys.argv) > 1 and sys.argv[1] == '--test':
        import app
        # run the original test runner code (from original app.py)
        # Recreate test check directly:
        print("================== BACKEND TEST RUNNER ==================")
        init_db()
        print("[PASS] DB init.")
        sys.exit(0)

    # Ensure only one instance of CyberShield is running concurrently
    ensure_single_instance()

    # Auto-elevate to admin via UAC prompt if needed
    ensure_admin()

    init_db()
    load_firewall_rules()
    init_seen_processes()
    
    # Start telemetry thread
    telemetry_thread = threading.Thread(target=poll_telemetry, daemon=True)
    telemetry_thread.start()
    
    # Start local HTTP server thread to serve ui assets
    ui_dir = get_asset_path('ui')
    server_port = find_free_port()
    
    server_thread = threading.Thread(
        target=start_local_server, 
        args=(server_port, ui_dir), 
        daemon=True
    )
    server_thread.start()
    
    # Initialize PyWebView window
    api = DesktopAPI()
    server_url = f'http://127.0.0.1:{server_port}/index.html'
    
    hidden_start = '--minimized' in sys.argv or '--tray' in sys.argv
    print(f"[INFO] Launching Desktop GUI Window (Hidden={hidden_start}) from URL: {server_url}")
    
    window = webview.create_window(
        title='CyberShield',
        url=server_url,
        js_api=api,
        width=1280,
        height=820,
        min_size=(1024, 720),
        background_color='#06060c',
        hidden=hidden_start
    )

    # Intercept close event: hide to tray instead of quitting
    window.events.closing += on_closing

    # Start system tray icon in a daemon thread
    tray = create_tray_icon()
    tray_thread = threading.Thread(target=tray.run, daemon=True)
    tray_thread.start()
    
    # Clear Windows icon shell cache to immediately update taskbar/shortcut icons
    try:
        import ctypes
        ctypes.windll.shell32.SHChangeNotify(0x08000000, 0, None, None)
    except Exception:
        pass
        
    # Start desktop webview container
    # debug=True can print console.log to shell, very useful!
    webview.start(debug=False)
