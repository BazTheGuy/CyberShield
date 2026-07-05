import os
import sys
import shutil
import ctypes
import subprocess
import winreg
import time
import tkinter as tk
from tkinter import ttk, filedialog, messagebox

# Application Metadata
APP_NAME = "CyberShield"
DEFAULT_INSTALL_DIR = os.path.join(os.environ.get("ProgramFiles", "C:\\Program Files"), APP_NAME)

def get_icon_path():
    if getattr(sys, 'frozen', False) and hasattr(sys, '_MEIPASS'):
        return os.path.join(sys._MEIPASS, 'cyber_shield_icon.ico')
    return 'cyber_shield_icon.ico'

def is_admin():
    try:
        return ctypes.windll.shell32.IsUserAnAdmin()
    except Exception:
        return False

def elevate():
    if not is_admin():
        # Re-launch the installer with Admin privileges
        ctypes.windll.shell32.ShellExecuteW(
            None, 'runas', sys.executable, ' '.join(sys.argv), None, 1
        )
        sys.exit(0)

_taskbar_shown = set()

def show_in_taskbar(root):
    # Prevent infinite loop on Map events
    if id(root) in _taskbar_shown:
        return
    _taskbar_shown.add(id(root))
    
    try:
        # Get HWND of Tk window
        hwnd = ctypes.windll.user32.GetParent(root.winfo_id())
        if hwnd == 0:
            hwnd = root.winfo_id()
        
        # Get window style
        GWL_EXSTYLE = -20
        WS_EX_APPWINDOW = 0x00040000
        WS_EX_TOOLWINDOW = 0x00000080
        
        style = ctypes.windll.user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
        style = (style | WS_EX_APPWINDOW) & ~WS_EX_TOOLWINDOW
        ctypes.windll.user32.SetWindowLongW(hwnd, GWL_EXSTYLE, style)
        
        # Force Windows to recreate the taskbar button by withdrawing and deiconifying the window
        root.withdraw()
        root.deiconify()
    except Exception:
        pass

# Pure silent shortcut link generation via WScript VBS (no PowerShell windows flashing!)
def create_shortcut_silent(target, shortcut_path, description=""):
    vbs_content = (
        f'Set oWS = CreateObject("WScript.Shell")\n'
        f'Set oLink = oWS.CreateShortcut("{shortcut_path}")\n'
        f'oLink.TargetPath = "{target}"\n'
        f'oLink.Description = "{description}"\n'
        f'oLink.WorkingDirectory = "{os.path.dirname(target)}"\n'
        f'oLink.Save\n'
    )
    vbs_path = os.path.join(os.environ["TEMP"], "create_lnk.vbs")
    try:
        with open(vbs_path, 'w', encoding='utf-8') as f:
            f.write(vbs_content)
        # Run wscript.exe silently (no window pops up)
        subprocess.run(["wscript.exe", "//nologo", vbs_path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        os.remove(vbs_path)
    except Exception:
        pass

def remove_shortcut(shortcut_path):
    if os.path.exists(shortcut_path):
        try:
            os.remove(shortcut_path)
        except Exception:
            pass

def register_uninstaller(install_dir, exe_path):
    reg_path = f"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{APP_NAME}"
    try:
        key = winreg.CreateKeyEx(winreg.HKEY_LOCAL_MACHINE, reg_path, 0, winreg.KEY_WRITE)
        winreg.SetValueEx(key, "DisplayName", 0, winreg.REG_SZ, "CyberShield")
        winreg.SetValueEx(key, "UninstallString", 0, winreg.REG_SZ, f'"{os.path.join(install_dir, "uninstall.exe")}"')
        winreg.SetValueEx(key, "DisplayIcon", 0, winreg.REG_SZ, exe_path)
        winreg.SetValueEx(key, "Publisher", 0, winreg.REG_SZ, "Baz Labs")
        winreg.SetValueEx(key, "DisplayVersion", 0, winreg.REG_SZ, "1.0.0")
        winreg.CloseKey(key)
    except Exception as e:
        print("Failed to register uninstaller:", e)

def unregister_uninstaller():
    reg_path = f"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{APP_NAME}"
    try:
        winreg.DeleteKey(winreg.HKEY_LOCAL_MACHINE, reg_path)
    except Exception as e:
        print("Failed to unregister uninstaller:", e)

def register_startup(install_dir, enabled=True):
    task_name = "CyberShieldStartup"
    # First delete existing task
    subprocess.run(["schtasks", "/delete", "/tn", task_name, "/f"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    
    # Also clean up old registry Run entry if it exists
    try:
        key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Run", 0, winreg.KEY_WRITE)
        try:
            winreg.DeleteValue(key, "CyberShield")
        except FileNotFoundError:
            pass
        winreg.CloseKey(key)
    except Exception:
        pass

    if enabled:
        exe_cmd = f'"{os.path.join(install_dir, "CyberShield.exe")}" --minimized'
        # Create Task Scheduler task to run at logon with highest privileges (no UAC prompt on boot!)
        subprocess.run(
            ["schtasks", "/create", "/tn", task_name, "/tr", exe_cmd, "/sc", "onlogon", "/rl", "highest", "/f"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )

def register_compatibility_layer(exe_path, enabled=True):
    try:
        key = winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers",
            0,
            winreg.KEY_WRITE
        )
    except FileNotFoundError:
        try:
            key = winreg.CreateKey(
                winreg.HKEY_CURRENT_USER,
                r"Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers"
            )
        except Exception:
            return
    try:
        if enabled:
            winreg.SetValueEx(key, exe_path, 0, winreg.REG_SZ, "~ RUNASADMIN")
        else:
            try:
                winreg.DeleteValue(key, exe_path)
            except FileNotFoundError:
                pass
        winreg.CloseKey(key)
    except Exception as e:
        print("Failed to set compatibility layer:", e)


# Custom themed modal dialog to replace default amateur Windows message boxes
class CyberDialog(tk.Toplevel):
    def __init__(self, parent, title, message, is_error=True):
        super().__init__(parent)
        self.overrideredirect(True)
        self.configure(bg="#0c0e17")
        
        # Center dialog relative to parent window
        parent_x = parent.winfo_x()
        parent_y = parent.winfo_y()
        w = 400
        h = 190
        x = parent_x + int((540 - w) / 2)
        y = parent_y + int((390 - h) / 2)
        self.geometry(f"{w}x{h}+{x}+{y}")
        
        # Glowing border frame (Red for errors, Cyan for info)
        accent_color = "#ff0055" if is_error else "#00f0ff"
        border = tk.Frame(self, bg=accent_color, bd=2)
        border.pack(fill="both", expand=True)
        
        inner = tk.Frame(border, bg="#0c0e17")
        inner.pack(fill="both", expand=True, padx=2, pady=2)
        
        # Header title
        title_lbl = tk.Label(
            inner,
            text=f"// SYSTEM_{title.upper()}_ALERT",
            font=("Consolas", 10, "bold"),
            fg=accent_color,
            bg="#0c0e17"
        )
        title_lbl.pack(anchor="w", padx=20, pady=(20, 5))
        
        # Message text
        msg_lbl = tk.Label(
            inner,
            text=message,
            font=("Consolas", 9),
            fg="#8f9bb3",
            bg="#0c0e17",
            justify="left",
            wraplength=350
        )
        msg_lbl.pack(fill="both", expand=True, padx=20, pady=10)
        
        # Button frame
        btn_frame = tk.Frame(inner, bg="#0c0e17")
        btn_frame.pack(fill="x", side="bottom", pady=15, padx=20)
        
        dismiss_btn = tk.Button(
            btn_frame,
            text="DISMISS" if is_error else "CONTINUE",
            font=("Consolas", 9, "bold"),
            bg=accent_color,
            fg="#0c0e17",
            activebackground=accent_color,
            activeforeground="#0c0e17",
            bd=0,
            cursor="hand2",
            padx=20,
            pady=4,
            command=self.destroy
        )
        dismiss_btn.pack(side="right")
        
        # Block until dialog is dismissed
        self.transient(parent)
        self.grab_set()
        parent.wait_window(self)


class CyberConfirmDialog(tk.Toplevel):
    def __init__(self, parent, title, message):
        super().__init__(parent)
        self.result = False
        self.overrideredirect(True)
        self.configure(bg="#0c0e17")
        
        # Center dialog relative to screen or parent
        parent.update_idletasks()
        if parent.winfo_viewable():
            parent_x = parent.winfo_x()
            parent_y = parent.winfo_y()
            pw = parent.winfo_width()
            ph = parent.winfo_height()
            w = 400
            h = 190
            x = parent_x + int((pw - w) / 2)
            y = parent_y + int((ph - h) / 2)
        else:
            w = 400
            h = 190
            sw = self.winfo_screenwidth()
            sh = self.winfo_screenheight()
            x = int((sw - w) / 2)
            y = int((sh - h) / 2)
            
        self.geometry(f"{w}x{h}+{x}+{y}")
        
        # Glowing border frame (Orange/Yellow for warnings/confirmation)
        accent_color = "#ffaa00"
        border = tk.Frame(self, bg=accent_color, bd=2)
        border.pack(fill="both", expand=True)
        
        inner = tk.Frame(border, bg="#0c0e17")
        inner.pack(fill="both", expand=True, padx=2, pady=2)
        
        # Header title
        title_lbl = tk.Label(
            inner,
            text=f"// SYSTEM_{title.upper()}_ALERT",
            font=("Consolas", 10, "bold"),
            fg=accent_color,
            bg="#0c0e17"
        )
        title_lbl.pack(anchor="w", padx=20, pady=(20, 5))
        
        # Message text
        msg_lbl = tk.Label(
            inner,
            text=message,
            font=("Consolas", 9),
            fg="#8f9bb3",
            bg="#0c0e17",
            justify="left",
            wraplength=350
        )
        msg_lbl.pack(fill="both", expand=True, padx=20, pady=10)
        
        # Button frame
        btn_frame = tk.Frame(inner, bg="#0c0e17")
        btn_frame.pack(fill="x", side="bottom", pady=15, padx=20)
        
        def on_confirm():
            self.result = True
            self.destroy()
            
        def on_cancel():
            self.result = False
            self.destroy()
            
        cancel_btn = tk.Button(
            btn_frame,
            text="CANCEL",
            font=("Consolas", 9, "bold"),
            bg="#334155",
            fg="#f8fafc",
            activebackground="#475569",
            activeforeground="#f8fafc",
            bd=0,
            cursor="hand2",
            padx=20,
            pady=4,
            command=on_cancel
        )
        cancel_btn.pack(side="left")
        
        confirm_btn = tk.Button(
            btn_frame,
            text="CONFIRM",
            font=("Consolas", 9, "bold"),
            bg=accent_color,
            fg="#0c0e17",
            activebackground=accent_color,
            activeforeground="#0c0e17",
            bd=0,
            cursor="hand2",
            padx=20,
            pady=4,
            command=on_confirm
        )
        confirm_btn.pack(side="right")
        
        # Block until dialog is dismissed
        self.transient(parent)
        self.grab_set()
        parent.wait_window(self)


# Custom retro-cyber toggle checkbox
class CyberCheckbutton(tk.Frame):
    def __init__(self, parent, text, variable, **kwargs):
        super().__init__(parent, bg="#0c0e17", **kwargs)
        self.var = variable
        
        # Box icon indicator [✓] or [ ]
        self.box_lbl = tk.Label(
            self,
            text="[✓]" if self.var.get() else "[ ]",
            font=("Consolas", 10, "bold"),
            fg="#00f0ff" if self.var.get() else "#64748b",
            bg="#0c0e17",
            cursor="hand2"
        )
        self.box_lbl.pack(side="left")
        
        # Label text
        self.text_lbl = tk.Label(
            self,
            text=text,
            font=("Consolas", 9, "bold"),
            fg="#8f9bb3",
            bg="#0c0e17",
            cursor="hand2"
        )
        self.text_lbl.pack(side="left", padx=8)
        
        self.box_lbl.bind("<Button-1>", self.toggle)
        self.text_lbl.bind("<Button-1>", self.toggle)
        
    def toggle(self, event):
        new_val = not self.var.get()
        self.var.set(new_val)
        self.box_lbl.config(
            text="[✓]" if new_val else "[ ]",
            fg="#00f0ff" if new_val else "#64748b"
        )


# Uninstaller execution logic
def run_uninstaller():
    elevate()
    
    # Custom styled uninstaller dialog running directly on the main root window
    root = tk.Tk()
    root.overrideredirect(True)
    root.configure(bg="#0c0e17")
    try:
        root.iconbitmap(get_icon_path())
    except Exception:
        pass
        
    # Center window
    w = 400
    h = 190
    sw = root.winfo_screenwidth()
    sh = root.winfo_screenheight()
    x = int((sw - w) / 2)
    y = int((sh - h) / 2)
    root.geometry(f"{w}x{h}+{x}+{y}")
    
    root.bind("<Map>", lambda e: show_in_taskbar(root))
    root.after(50, lambda: show_in_taskbar(root))
    
    # Glowing border frame (Orange/Yellow for warnings/confirmation)
    accent_color = "#ffaa00"
    border = tk.Frame(root, bg=accent_color, bd=2)
    border.pack(fill="both", expand=True)
    
    inner = tk.Frame(border, bg="#0c0e17")
    inner.pack(fill="both", expand=True, padx=2, pady=2)
    
    # Header title
    title_lbl = tk.Label(
        inner,
        text="// SYSTEM_UNINSTALL_ALERT",
        font=("Consolas", 10, "bold"),
        fg=accent_color,
        bg="#0c0e17"
    )
    title_lbl.pack(anchor="w", padx=20, pady=(20, 5))
    
    # Message text
    msg_lbl = tk.Label(
        inner,
        text="Are you sure you want to completely uninstall CyberShield and all its components?",
        font=("Consolas", 9),
        fg="#8f9bb3",
        bg="#0c0e17",
        justify="left",
        wraplength=350
    )
    msg_lbl.pack(fill="both", expand=True, padx=20, pady=10)
    
    # Button frame
    btn_frame = tk.Frame(inner, bg="#0c0e17")
    btn_frame.pack(fill="x", side="bottom", pady=15, padx=20)
    
    confirm_status = {"val": False}
    
    def on_confirm():
        confirm_status["val"] = True
        root.destroy()
        
    def on_cancel():
        confirm_status["val"] = False
        root.destroy()
        
    cancel_btn = tk.Button(
        btn_frame,
        text="CANCEL",
        font=("Consolas", 9, "bold"),
        bg="#334155",
        fg="#f8fafc",
        activebackground="#475569",
        activeforeground="#f8fafc",
        bd=0,
        cursor="hand2",
        padx=20,
        pady=4,
        command=on_cancel
    )
    cancel_btn.pack(side="left")
    
    confirm_btn = tk.Button(
        btn_frame,
        text="CONFIRM",
        font=("Consolas", 9, "bold"),
        bg=accent_color,
        fg="#0c0e17",
        activebackground=accent_color,
        activeforeground="#0c0e17",
        bd=0,
        cursor="hand2",
        padx=20,
        pady=4,
        command=on_confirm
    )
    confirm_btn.pack(side="right")
    
    root.mainloop()
    
    if not confirm_status["val"]:
        sys.exit(0)
        
    # Silently kill any active instances running to release locked files
    subprocess.run(["taskkill", "/f", "/im", "CyberShield.exe"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(0.5)
        
    desktop = os.path.join(os.environ["USERPROFILE"], "Desktop")
    start_menu = os.path.join(os.environ["ALLUSERSPROFILE"], "Microsoft\\Windows\\Start Menu\\Programs")
    
    remove_shortcut(os.path.join(desktop, f"{APP_NAME}.lnk"))
    remove_shortcut(os.path.join(start_menu, f"{APP_NAME}.lnk"))
    
    install_dir = os.path.dirname(sys.executable)
    
    # Unregister from registry and task scheduler
    unregister_uninstaller()
    register_startup(install_dir, enabled=False)
    register_compatibility_layer(os.path.join(install_dir, "CyberShield.exe"), enabled=False)
    
    # Silent PowerShell command for directory cleanup
    # Final success alert (using main root window directly)
    success_root = tk.Tk()
    success_root.overrideredirect(True)
    success_root.configure(bg="#0c0e17")
    try:
        success_root.iconbitmap(get_icon_path())
    except Exception:
        pass
        
    success_root.geometry(f"{w}x{h}+{x}+{y}")
    
    success_root.bind("<Map>", lambda e: show_in_taskbar(success_root))
    success_root.after(50, lambda: show_in_taskbar(success_root))
    
    border = tk.Frame(success_root, bg="#00f0ff", bd=2)
    border.pack(fill="both", expand=True)
    inner = tk.Frame(border, bg="#0c0e17")
    inner.pack(fill="both", expand=True, padx=2, pady=2)
    
    title_lbl = tk.Label(
        inner,
        text="// SYSTEM_UNINSTALL_COMPLETE",
        font=("Consolas", 10, "bold"),
        fg="#00f0ff",
        bg="#0c0e17"
    )
    title_lbl.pack(anchor="w", padx=20, pady=(20, 5))
    
    msg_lbl = tk.Label(
        inner,
        text="CyberShield has been successfully uninstalled.",
        font=("Consolas", 9),
        fg="#8f9bb3",
        bg="#0c0e17",
        justify="left",
        wraplength=350
    )
    msg_lbl.pack(fill="both", expand=True, padx=20, pady=10)
    
    btn_frame = tk.Frame(inner, bg="#0c0e17")
    btn_frame.pack(fill="x", side="bottom", pady=15, padx=20)
    
    def on_success_close():
        success_root.destroy()
        # Spawn the silent powershell cleanup script ONLY after the GUI has fully closed and exited!
        clean_cmd = (
            f"Start-Sleep -Seconds 1; "
            f"Remove-Item -Path '{os.path.join(install_dir, 'CyberShield.exe')}' -Force -ErrorAction SilentlyContinue; "
            f"Remove-Item -Path '{os.path.join(install_dir, 'uninstall.exe')}' -Force -ErrorAction SilentlyContinue; "
            f"Remove-Item -Path '{install_dir}' -Force -ErrorAction SilentlyContinue;"
        )
        subprocess.Popen(["powershell", "-WindowStyle", "Hidden", "-Command", clean_cmd], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        sys.exit(0)
        
    dismiss_btn = tk.Button(
        btn_frame,
        text="CONTINUE",
        font=("Consolas", 9, "bold"),
        bg="#00f0ff",
        fg="#0c0e17",
        activebackground="#00f0ff",
        activeforeground="#0c0e17",
        bd=0,
        cursor="hand2",
        padx=20,
        pady=4,
        command=on_success_close
    )
    dismiss_btn.pack(side="right")
    
    success_root.mainloop()


# Main Installer GUI
class InstallerWizard:
    def __init__(self, root):
        self.root = root
        self.root.overrideredirect(True) # Remove windows default window frame/borders
        self.root.configure(bg="#0c0e17")
        
        # Center window
        self.width = 540
        self.height = 390
        screen_width = self.root.winfo_screenwidth()
        screen_height = self.root.winfo_screenheight()
        x = int((screen_width / 2) - (self.width / 2))
        y = int((screen_height / 2) - (self.height / 2))
        self.root.geometry(f"{self.width}x{self.height}+{x}+{y}")
        
        self.root.bind("<Map>", lambda e: show_in_taskbar(self.root))
        self.root.after(50, lambda: show_in_taskbar(self.root))
        
        # Border overlay (cyber neon cyan double border style)
        self.border_frame = tk.Frame(self.root, bg="#00f0ff", bd=2)
        self.border_frame.pack(fill="both", expand=True)
        
        self.inner_frame = tk.Frame(self.border_frame, bg="#0c0e17")
        self.inner_frame.pack(fill="both", expand=True, padx=2, pady=2)
        
        # Enable custom dragging behavior
        self.inner_frame.bind("<Button-1>", self.start_drag)
        self.inner_frame.bind("<B1-Motion>", self.drag)

        # Custom header titlebar
        self.header = tk.Frame(self.inner_frame, bg="#131722", height=45)
        self.header.pack(fill="x")
        self.header.bind("<Button-1>", self.start_drag)
        self.header.bind("<B1-Motion>", self.drag)
        
        title_lbl = tk.Label(
            self.header,
            text="[CYBERSHIELD SETUP WIZARD] // v1.0",
            font=("Consolas", 11, "bold"),
            fg="#00f0ff",
            bg="#131722"
        )
        title_lbl.pack(side="left", padx=15, pady=12)
        title_lbl.bind("<Button-1>", self.start_drag)
        title_lbl.bind("<B1-Motion>", self.drag)

        close_btn = tk.Button(
            self.header,
            text="X",
            font=("Consolas", 10, "bold"),
            fg="#64748b",
            bg="#131722",
            activeforeground="#ff0055",
            activebackground="#131722",
            bd=0,
            cursor="hand2",
            command=self.root.destroy
        )
        close_btn.pack(side="right", padx=15, pady=12)

        # Content frame
        self.content = tk.Frame(self.inner_frame, bg="#0c0e17")
        self.content.pack(fill="both", expand=True, padx=24, pady=(15, 0))

        # Bottom buttons frame (Defined ONCE to prevent duplicates when reloading welcome screen)
        self.btn_frame = tk.Frame(self.inner_frame, bg="#0c0e17", height=50)
        self.btn_frame.pack(fill="x", side="bottom", pady=(0, 20), padx=24)

        # Progress styling
        self.style = ttk.Style()
        self.style.theme_use('default')
        self.style.configure(
            "Cyber.Horizontal.TProgressbar",
            troughcolor='#131722',
            background='#00f0ff',
            thickness=4,
            borderwidth=0
        )
        
        self.startup_var = tk.BooleanVar(value=True)
        self.show_welcome_screen()

    def start_drag(self, event):
        self.drag_x = event.x
        self.drag_y = event.y

    def drag(self, event):
        deltax = event.x - self.drag_x
        deltay = event.y - self.drag_y
        x = self.root.winfo_x() + deltax
        y = self.root.winfo_y() + deltay
        self.root.geometry(f"+{x}+{y}")

    def clear_content(self):
        for widget in self.content.winfo_children():
            widget.destroy()
        for widget in self.btn_frame.winfo_children():
            widget.destroy()

    def make_btn_hover(self, btn, normal_bg, normal_fg, hover_bg, hover_fg):
        btn.bind("<Enter>", lambda e: btn.config(bg=hover_bg, fg=hover_fg))
        btn.bind("<Leave>", lambda e: btn.config(bg=normal_bg, fg=normal_fg))

    def show_welcome_screen(self):
        self.clear_content()
        
        desc = (
            "Select directory path and configure installation settings to install CyberShield. "
            "Requires UAC Administrator privileges to manage core firewall blocking."
        )
        
        lbl = tk.Label(
            self.content,
            text=desc,
            font=("Consolas", 10),
            fg="#8f9bb3",
            bg="#0c0e17",
            justify="left",
            wraplength=480
        )
        lbl.pack(pady=(5, 15), fill="x")

        # Path Selection
        path_frame = tk.Frame(self.content, bg="#0c0e17")
        path_frame.pack(fill="x", pady=10)
        
        path_lbl = tk.Label(
            path_frame,
            text="INSTALL_DIR:",
            font=("Consolas", 10, "bold"),
            fg="#ff0055",
            bg="#0c0e17"
        )
        path_lbl.pack(side="left")

        self.path_var = tk.StringVar(value=DEFAULT_INSTALL_DIR)
        self.path_entry = tk.Entry(
            path_frame,
            textvariable=self.path_var,
            font=("Consolas", 9),
            bg="#131722",
            fg="#fff",
            insertbackground="#00f0ff",
            bd=1,
            relief="flat",
            highlightthickness=1,
            highlightbackground="#1b2030",
            highlightcolor="#00f0ff"
        )
        self.path_entry.pack(side="left", fill="x", expand=True, padx=10, ipady=4)

        browse_btn = tk.Button(
            path_frame,
            text="BROWSE",
            font=("Consolas", 8, "bold"),
            bg="#1b2030",
            fg="#00f0ff",
            activebackground="#00f0ff",
            activeforeground="#0c0e17",
            bd=0,
            relief="flat",
            cursor="hand2",
            padx=12,
            pady=3,
            command=self.browse_path
        )
        browse_btn.pack(side="left")
        self.make_btn_hover(browse_btn, "#1b2030", "#00f0ff", "#00f0ff", "#0c0e17")

        # Startup check button (Custom premium Vb-style checkbox widget)
        chk_frame = tk.Frame(self.content, bg="#0c0e17")
        chk_frame.pack(fill="x", pady=15)

        chk = CyberCheckbutton(chk_frame, "LAUNCH CYBERSHIELD ON WINDOWS STARTUP (IN BACKGROUND)", self.startup_var)
        chk.pack(anchor="w")

        # Bottom Buttons inside the global btn_frame
        cancel_btn = tk.Button(
            self.btn_frame,
            text="CANCEL",
            font=("Consolas", 9, "bold"),
            bg="#1b2030",
            fg="#8f9bb3",
            activebackground="#ff0055",
            activeforeground="#fff",
            bd=0,
            cursor="hand2",
            padx=20,
            pady=6,
            command=self.root.destroy
        )
        cancel_btn.pack(side="left")
        self.make_btn_hover(cancel_btn, "#1b2030", "#8f9bb3", "#ff0055", "#fff")

        install_btn = tk.Button(
            self.btn_frame,
            text="INITIALIZE_INSTALL",
            font=("Consolas", 9, "bold"),
            bg="#00f0ff",
            fg="#0c0e17",
            activebackground="#00f0ff",
            activeforeground="#0c0e17",
            bd=0,
            cursor="hand2",
            padx=24,
            pady=6,
            command=self.start_installation
        )
        install_btn.pack(side="right")
        self.make_btn_hover(install_btn, "#00f0ff", "#0c0e17", "#00d0df", "#0c0e17")

    def browse_path(self):
        chosen = filedialog.askdirectory(initialdir=DEFAULT_INSTALL_DIR)
        if chosen:
            self.path_var.set(chosen.replace('/', '\\'))

    def start_installation(self):
        install_dir = self.path_var.get()
        self.clear_content()

        base_dir = getattr(sys, '_MEIPASS', os.path.dirname(os.path.abspath(__file__)))
        source_exe = os.path.join(base_dir, "CyberShield.exe")
        
        if not os.path.exists(source_exe):
            source_exe = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dist", "CyberShield.exe")

        if not os.path.exists(source_exe):
            CyberDialog(self.root, "source_error", f"Cannot locate source bytes for CyberShield.exe.\nPlease rebuild before running setup.")
            self.show_welcome_screen()
            return

        # Progress UI
        self.progress_lbl = tk.Label(
            self.content,
            text="CONNECTING TO CORE SUBSYSTEM...",
            font=("Consolas", 10),
            fg="#00f0ff",
            bg="#0c0e17",
            anchor="w"
        )
        self.progress_lbl.pack(pady=(45, 10), fill="x")

        self.progress = ttk.Progressbar(
            self.content,
            style="Cyber.Horizontal.TProgressbar",
            mode='determinate'
        )
        self.progress.pack(fill="x", pady=10)

        # Silent Cancel button during copy phase
        cancel_btn = tk.Button(
            self.btn_frame,
            text="CANCEL",
            font=("Consolas", 9, "bold"),
            bg="#1b2030",
            fg="#64748b",
            bd=0,
            padx=20,
            pady=6,
            state="disabled"
        )
        cancel_btn.pack(side="left")

        self.root.update()
        
        try:
            # Step 1: Create folders
            self.progress_lbl.config(text="[OK] CREATING SYSTEM SUBDIRECTORIES...")
            self.progress['value'] = 20
            self.root.update()
            time.sleep(0.3)
            os.makedirs(install_dir, exist_ok=True)

            # Step 2: Copy executable
            self.progress_lbl.config(text="[OK] COPYING CYBERSHIELD CORE BINARIES...")
            self.progress['value'] = 50
            self.root.update()
            time.sleep(0.2)
            
            dest_exe = os.path.join(install_dir, "CyberShield.exe")
            
            # Silently kill any active instances running to release locked files
            subprocess.run(["taskkill", "/f", "/im", "CyberShield.exe"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            time.sleep(0.2)
            
            try:
                shutil.copy2(source_exe, dest_exe)
            except PermissionError:
                # Prompt with a custom alert
                CyberDialog(
                    self.root,
                    "file_locked",
                    "Permission Denied: 'CyberShield.exe' is currently running or locked by another process.\n"
                    "Please exit the program and system tray, then press DISMISS to try again."
                )
                # Attempt second copy
                shutil.copy2(source_exe, dest_exe)

            # Copy self as uninstall.exe
            dest_uninstaller = os.path.join(install_dir, "uninstall.exe")
            shutil.copy2(sys.executable, dest_uninstaller)

            # Step 3: Shortcuts (using completely silent wscript)
            self.progress_lbl.config(text="[OK] REGISTRATING SHORTCUT SYSTEM LINKS...")
            self.progress['value'] = 75
            self.root.update()
            time.sleep(0.3)

            desktop = os.path.join(os.environ["USERPROFILE"], "Desktop")
            start_menu = os.path.join(os.environ["ALLUSERSPROFILE"], "Microsoft\\Windows\\Start Menu\\Programs")
            
            create_shortcut_silent(dest_exe, os.path.join(desktop, f"{APP_NAME}.lnk"), "CyberShield Network Monitor")
            create_shortcut_silent(dest_exe, os.path.join(start_menu, f"{APP_NAME}.lnk"), "CyberShield Network Monitor")

            # Step 4: Registry Entry
            self.progress_lbl.config(text="[OK] COMPILING UNINSTALL REGISTRY SYSTEM HASHES...")
            self.progress['value'] = 90
            self.root.update()
            time.sleep(0.2)
            register_uninstaller(install_dir, dest_exe)

            # Configure startup launch and compatibility layers
            register_startup(install_dir, enabled=self.startup_var.get())
            register_compatibility_layer(dest_exe, enabled=True)

            # Clear Windows icon shell cache to immediately update taskbar/shortcut icons
            try:
                ctypes.windll.shell32.SHChangeNotify(0x08000000, 0, None, None)
            except Exception:
                pass

            self.progress['value'] = 100
            self.progress_lbl.config(text="[OK] SYSTEM INSTALL COMPLETE!")
            self.root.update()
            time.sleep(0.4)

            self.show_success_screen(dest_exe)

        except Exception as err:
            CyberDialog(self.root, "install_error", f"Installation aborted:\n{err}")
            self.show_welcome_screen()

    def show_success_screen(self, dest_exe):
        self.clear_content()

        lbl = tk.Label(
            self.content,
            text="INSTALLATION COMPLETED",
            font=("Consolas", 12, "bold"),
            fg="#00f0ff",
            bg="#0c0e17"
        )
        lbl.pack(pady=(15, 10))

        desc = tk.Label(
            self.content,
            text="CyberShield has been successfully installed.\n"
                 "Shortcut nodes created on Desktop and Start Menu.",
            font=("Consolas", 9),
            fg="#8f9bb3",
            bg="#0c0e17",
            justify="center",
            wraplength=450
        )
        desc.pack(pady=10)

        # Launch checkbox
        self.launch_var = tk.BooleanVar(value=True)
        chk_frame = tk.Frame(self.content, bg="#0c0e17")
        chk_frame.pack(pady=15)
        chk = CyberCheckbutton(chk_frame, "RUN CYBERSHIELD NOW", self.launch_var)
        chk.pack()

        # Finish button inside the global btn_frame
        finish_btn = tk.Button(
            self.btn_frame,
            text="FINISH",
            font=("Consolas", 9, "bold"),
            bg="#00f0ff",
            fg="#0c0e17",
            activebackground="#00f0ff",
            activeforeground="#0c0e17",
            bd=0,
            cursor="hand2",
            padx=35,
            pady=6,
            command=lambda: self.finish_setup(dest_exe)
        )
        finish_btn.pack(side="right")
        self.make_btn_hover(finish_btn, "#00f0ff", "#0c0e17", "#00d0df", "#0c0e17")

    def finish_setup(self, dest_exe):
        if self.launch_var.get():
            # Start application in admin mode
            subprocess.Popen([dest_exe], shell=True)
        self.root.destroy()


# Entrypoint routing
if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "/uninstall" or os.path.basename(sys.executable).lower() == "uninstall.exe":
        run_uninstaller()
    else:
        elevate()
        root = tk.Tk()
        try:
            root.iconbitmap(get_icon_path())
        except Exception:
            pass
        app = InstallerWizard(root)
        root.mainloop()
