using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

// This out-of-process owner restores foreign windows on EOF and parent death.
public static class CanvasDesktopHost {
  [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct Point { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] struct Placement { public int Length, Flags, Show; public Point Min, Max; public Rect Normal; }
  delegate bool EnumProc(IntPtr hwnd, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr data);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool GetWindowPlacement(IntPtr hwnd, ref Placement placement);
  [DllImport("user32.dll")] static extern bool SetWindowPlacement(IntPtr hwnd, ref Placement placement);
  [DllImport("user32.dll")] static extern IntPtr GetWindowDpiAwarenessContext(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool AreDpiAwarenessContextsEqual(IntPtr first, IntPtr second);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint command);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hwnd, int index);
  [DllImport("user32.dll", SetLastError=true)] static extern int SetWindowLong(IntPtr hwnd, int index, int value);
  [DllImport("user32.dll", SetLastError=true)] static extern IntPtr SetParent(IntPtr child, IntPtr parent);
  [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int command);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int w, int h, uint flags);
  [DllImport("kernel32.dll")] static extern void SetLastError(uint error);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out int value, int size);
  const int Style=-16, ExStyle=-20, Child=0x40000000, Popup=unchecked((int)0x80000000), Caption=0x00C00000, ThickFrame=0x00040000;
  static Control dispatcher;
  static ApplicationContext context;
  static readonly Dictionary<string, Attachment> attached = new Dictionary<string, Attachment>();
  static int ownerPid;
  sealed class Attachment { public IntPtr Window, Parent; public int Style, ExStyle; public uint Pid; public Rect Bounds; public Placement Placement; public Form Host; }
  public sealed class Candidate { public string Handle { get; set; } public uint Pid { get; set; } public string Title { get; set; } public string Process { get; set; } }
  static T OnUi<T>(Func<T> action) { return (T)dispatcher.Invoke(action); }
  public static void Start(int parentPid) {
    ownerPid=parentPid;
    var ready=new ManualResetEvent(false);
    var thread=new Thread(() => {
      dispatcher=new Control(); var handle=dispatcher.Handle;
      context=new ApplicationContext();
      var timer=new System.Windows.Forms.Timer { Interval=500 };
      timer.Tick+=(s,e) => {
        bool alive;
        try { alive=!System.Diagnostics.Process.GetProcessById(ownerPid).HasExited; } catch { alive=false; }
        if (!alive) { RestoreAll(); context.ExitThread(); Environment.Exit(0); }
        foreach (var id in new List<string>(attached.Keys)) if (!Valid(attached[id])) DetachCore(id);
      };
      timer.Start(); ready.Set(); Application.Run(context); timer.Dispose(); dispatcher.Dispose();
    });
    thread.IsBackground=true; thread.SetApartmentState(ApartmentState.STA); thread.Start(); ready.WaitOne();
  }
  static bool Valid(Attachment item) { uint pid; return IsWindow(item.Window) && GetWindowThreadProcessId(item.Window,out pid)!=0 && pid==item.Pid; }
  public static Candidate[] List() {
    var result=new List<Candidate>();
    EnumWindows((window,data) => {
      if (!IsWindowVisible(window) || GetWindow(window,4)!=IntPtr.Zero) return true;
      uint pid; GetWindowThreadProcessId(window,out pid);
      if (pid==ownerPid || pid==System.Diagnostics.Process.GetCurrentProcess().Id) return true;
      int cloaked; if (DwmGetWindowAttribute(window,14,out cloaked,4)==0 && cloaked!=0) return true;
      var title=new StringBuilder(1024); GetWindowText(window,title,title.Capacity);
      if (title.Length==0 || (GetWindowLong(window,ExStyle)&0x80)!=0) return true;
      try {
        var process=System.Diagnostics.Process.GetProcessById((int)pid);
        if (process.SessionId!=System.Diagnostics.Process.GetCurrentProcess().SessionId) return true;
        result.Add(new Candidate { Handle=window.ToInt64().ToString(), Pid=pid, Title=title.ToString(), Process=process.ProcessName });
      } catch { }
      return true;
    },IntPtr.Zero);
    return result.ToArray();
  }
  public static void Attach(string id,string handle,uint expectedPid,string parentHandle) {
    OnUi(() => {
      var window=new IntPtr(long.Parse(handle)); var parent=new IntPtr(long.Parse(parentHandle));
      uint pid; GetWindowThreadProcessId(window,out pid);
      if (!IsWindow(window)||pid!=expectedPid||pid==ownerPid||!IsWindow(parent)) throw new InvalidOperationException("Window is no longer available.");
      var dpi=GetWindowDpiAwarenessContext(parent);
      if (!AreDpiAwarenessContextsEqual(GetWindowDpiAwarenessContext(window),dpi)) throw new InvalidOperationException("Window DPI modes differ. Embedding was refused to avoid changing the application's DPI mode.");
      SetThreadDpiAwarenessContext(dpi);
      foreach (var item in attached.Values) if (item.Window==window) throw new InvalidOperationException("Window is already embedded.");
      var entry=new Attachment { Window=window,Parent=GetParent(window),Style=GetWindowLong(window,Style),ExStyle=GetWindowLong(window,ExStyle),Pid=pid,Placement=new Placement { Length=Marshal.SizeOf(typeof(Placement)) } };
      GetWindowRect(window,out entry.Bounds);
      GetWindowPlacement(window,ref entry.Placement);
      entry.Host=new Form { TopLevel=false,FormBorderStyle=FormBorderStyle.None,ShowInTaskbar=false,BackColor=Color.Black };
      SetParent(entry.Host.Handle,parent);
      if (GetParent(entry.Host.Handle)!=parent) { entry.Host.Dispose(); throw new InvalidOperationException("Could not create the native viewport parent."); }
      attached.Add(id,entry);
      try {
        ShowWindow(window,9);
        int embeddedStyle=(entry.Style&~(Popup|Caption|ThickFrame))|Child;
        SetWindowLong(window,Style,embeddedStyle);
        if (GetWindowLong(window,Style)!=embeddedStyle) throw new InvalidOperationException("Could not change the application window style. Check its elevation.");
        SetParent(window,entry.Host.Handle);
        if (GetParent(window)!=entry.Host.Handle) throw new InvalidOperationException("The application refused native embedding. Check elevation and DPI compatibility.");
        ShowWindow(window,5); return true;
      } catch { DetachCore(id); throw; }
    });
  }
  public static void Update(string id,int x,int y,int width,int height,bool visible) {
    OnUi(() => {
      Attachment entry;
      if (!attached.TryGetValue(id,out entry)||!Valid(entry)) throw new InvalidOperationException("Application window was closed.");
      if (!visible) { entry.Host.Hide(); return true; }
      entry.Host.Bounds=new Rectangle(x,y,Math.Max(1,width),Math.Max(1,height));
      SetWindowPos(entry.Window,IntPtr.Zero,0,0,Math.Max(1,width),Math.Max(1,height),0x4034);
      entry.Host.Show(); return true;
    });
  }
  static void DetachCore(string id) {
    Attachment entry; if (!attached.TryGetValue(id,out entry)) return;
    attached.Remove(id);
    if (Valid(entry)) {
      ShowWindow(entry.Window,0); SetParent(entry.Window,IsWindow(entry.Parent)?entry.Parent:IntPtr.Zero);
      SetWindowLong(entry.Window,Style,entry.Style); SetWindowLong(entry.Window,ExStyle,entry.ExStyle);
      var r=entry.Bounds; SetWindowPos(entry.Window,IntPtr.Zero,r.Left,r.Top,r.Right-r.Left,r.Bottom-r.Top,0x0034);
      SetWindowPlacement(entry.Window,ref entry.Placement);
      ShowWindow(entry.Window,entry.Placement.Show);
    }
    entry.Host.Dispose();
  }
  static void RestoreAll() { foreach (var id in new List<string>(attached.Keys)) DetachCore(id); }
  public static void Detach(string id) { OnUi(() => { DetachCore(id); return true; }); }
  public static void Stop() { OnUi(() => { RestoreAll(); context.ExitThread(); return true; }); }
}
