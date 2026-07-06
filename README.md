## CyberShield v1.0
<p align="center">
  <img src="screenshot.png" alt="CyberShield" width="1920" height="640">
</p>

# CyberShield

### Core Functionality

* **Realtime Grid**: Displays active data flows by process name, connections, and speed, alongside an isometric 3D visualization representing network traffic as vehicles on a highway.
* **Usage Tracking**: Breaks down total bandwidth consumption into categorized traffic logs, filtering data by application, host IP, and protocol/port type.
* **Firewall Management**: Lists blocked applications and executable paths, serving as a frontend controller to manage Windows Defender Firewall rules directly.
* **Alerts Stream**: Audits and displays chronological logs of newly established network connections and first-time remote host communication sequences by process.
* **Device Scanner**: Scans the local subnet (`LAN_MAP`) to discover active nodes, mapping out device status, name, local IP address, MAC address, and node type.

---

### Tech Stack & System Integration

* **Backend**: Python, Flask, SQLite3.
* **Frontend**: HTML5, CSS3, JavaScript (Three.js for 3D graphics, Chart.js for data visualization).
* **System Hooks**: Leverages `psutil` and native Windows utilities to monitor processes, alter firewall configurations, and handle system tray operations.
