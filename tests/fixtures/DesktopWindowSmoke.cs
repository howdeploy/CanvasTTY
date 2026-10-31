public static class DesktopWindowSmoke {
  [System.Runtime.InteropServices.DllImport("user32.dll")] static extern System.IntPtr GetParent(System.IntPtr window);
  [System.Runtime.InteropServices.DllImport("user32.dll")] static extern int GetWindowLong(System.IntPtr window, int index);
  [System.Runtime.InteropServices.DllImport("user32.dll")] static extern bool IsWindowVisible(System.IntPtr window);
  public static void Run(int ownerPid) {
    CanvasDesktopHost.Start(ownerPid);
    var dispatcher=(System.Windows.Forms.Control)typeof(CanvasDesktopHost).GetField("dispatcher",System.Reflection.BindingFlags.NonPublic|System.Reflection.BindingFlags.Static).GetValue(null);
    try {
      dispatcher.Invoke(new System.Action(() => {
        using (var parent=new System.Windows.Forms.Form())
        using (var target=new System.Windows.Forms.Form()) {
          parent.StartPosition=target.StartPosition=System.Windows.Forms.FormStartPosition.Manual;
          parent.Location=target.Location=new System.Drawing.Point(-30000,-30000);
          parent.ShowInTaskbar=target.ShowInTaskbar=false;
          target.Text="CanvasTTY native fixture";
          parent.Show(); target.Show();
          var handle=target.Handle;
          var originalParent=GetParent(handle);
          var originalStyle=GetWindowLong(handle,-16);
          int clicks=0;
          var button=new System.Windows.Forms.Button(); button.Click+=(s,e)=>clicks++; target.Controls.Add(button);
          CanvasDesktopHost.Attach("fixture",handle.ToInt64().ToString(),(uint)System.Diagnostics.Process.GetCurrentProcess().Id,parent.Handle.ToInt64().ToString());
          if (GetParent(handle)==originalParent) throw new System.Exception("Attach did not reparent the native window.");
          CanvasDesktopHost.Update("fixture",10,20,640,480,true);
          if (target.Width!=640 || target.Height!=480) throw new System.Exception("Viewport size did not reach the target.");
          button.PerformClick();
          if (clicks!=1) throw new System.Exception("The hosted application's controls stopped working.");
          CanvasDesktopHost.Update("fixture",10,20,640,480,false);
          if (IsWindowVisible(handle)) throw new System.Exception("Hidden viewport left its native child visible.");
          CanvasDesktopHost.Detach("fixture");
          if (target.IsDisposed || GetParent(handle)!=originalParent || GetWindowLong(handle,-16)!=originalStyle) throw new System.Exception("Detach failed to restore the living window and styles.");
          CanvasDesktopHost.Detach("fixture");
          target.Close(); parent.Close();
        }
      }));
      System.Console.WriteLine("PASS native attach, resize, live controls, hide, detach, restore and repeated detach");
    } finally { CanvasDesktopHost.Stop(); }
  }
}
