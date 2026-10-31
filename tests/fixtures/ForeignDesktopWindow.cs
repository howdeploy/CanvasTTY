using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

public static class ForeignDesktopWindow {
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern IntPtr GetWindowDpiAwarenessContext(IntPtr window);
  [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr window);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr window,int index);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window,int command);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [STAThread] public static void Main(string[] args) {
    SetThreadDpiAwarenessContext(args.Length>0?GetWindowDpiAwarenessContext(new IntPtr(long.Parse(args[0]))):new IntPtr(-4));
    using (var form=new Form { Text="CanvasTTY Codex fixture",StartPosition=FormStartPosition.Manual,Location=new Point(-20000,-20000),Size=new Size(800,600) }) {
      var button=new Button { Text="Fixture control" }; int clicks=0;
      button.Click+=(s,e)=>clicks++; form.Controls.Add(button);
      var hwnd=form.Handle;
      form.Shown+=(s,e)=> {
        ShowWindow(hwnd,5);
        Console.WriteLine("{\"handle\":\""+hwnd.ToInt64()+"\",\"pid\":"+System.Diagnostics.Process.GetCurrentProcess().Id+",\"style\":"+GetWindowLong(hwnd,-16)+"}");
      };
      var reader=new Thread(() => {
        string command;
        while ((command=Console.ReadLine())!=null) {
          try {
            form.Invoke(new Action(() => {
              if (command=="click") button.PerformClick();
              if (command=="quit") { form.Close(); return; }
              Console.WriteLine("{\"parent\":\""+GetParent(hwnd).ToInt64()+"\",\"style\":"+GetWindowLong(hwnd,-16)+",\"width\":"+form.Width+",\"height\":"+form.Height+",\"visible\":"+(IsWindowVisible(hwnd)?"true":"false")+",\"clicks\":"+clicks+"}");
            }));
          } catch { return; }
        }
        try { form.BeginInvoke(new Action(()=>form.Close())); } catch { }
      });
      reader.IsBackground=true; reader.Start(); Application.Run(form);
    }
  }
}
