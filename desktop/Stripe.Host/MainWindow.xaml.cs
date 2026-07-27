using Microsoft.Web.WebView2.Core;
using Newtonsoft.Json.Linq;
using System;
using System.IO;
using System.Windows;

namespace Stripe.Host
{
    public partial class MainWindow : Window
    {
        private DesktopBridge _bridge;
        private bool _fullscreen;
        private WindowStyle _previousStyle;
        private WindowState _previousState;

        public MainWindow()
        {
            InitializeComponent();
            Loaded += MainWindow_Loaded;
        }

        private async void MainWindow_Loaded(object sender, RoutedEventArgs e)
        {
            try
            {
                var userData = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Stripe", "WebView2");
                Directory.CreateDirectory(userData);
                var environment = await CoreWebView2Environment.CreateAsync(null, userData);
                await Browser.EnsureCoreWebView2Async(environment);
                Browser.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
                Browser.CoreWebView2.Settings.IsStatusBarEnabled = false;
                Browser.CoreWebView2.Settings.AreBrowserAcceleratorKeysEnabled = true;
                Browser.CoreWebView2.WebMessageReceived += CoreWebView2_WebMessageReceived;
                Browser.NavigationCompleted += Browser_NavigationCompleted;
                _bridge = new DesktopBridge(this);

                var developmentUrl = Environment.GetEnvironmentVariable("STRIPE_DEV_URL");
                if (!string.IsNullOrWhiteSpace(developmentUrl))
                {
                    Browser.Source = new Uri(developmentUrl);
                }
                else
                {
                    var webRoot = Path.Combine(AppContext.BaseDirectory, "web");
                    Browser.CoreWebView2.SetVirtualHostNameToFolderMapping("stripe.local", webRoot, CoreWebView2HostResourceAccessKind.Allow);
                    Browser.Source = new Uri("https://stripe.local/index.html");
                }
            }
            catch (Exception exception)
            {
                LoadingPanel.Visibility = Visibility.Collapsed;
                MessageBox.Show(this, "无法启动 WebView2。请确认 Microsoft Edge WebView2 Runtime 已安装。\n\n" + exception.Message, "启动失败", MessageBoxButton.OK, MessageBoxImage.Error);
                Close();
            }
        }

        private void Browser_NavigationCompleted(object sender, CoreWebView2NavigationCompletedEventArgs e)
        {
            LoadingPanel.Visibility = Visibility.Collapsed;
            if (!e.IsSuccess)
                MessageBox.Show(this, "工作台页面加载失败：" + e.WebErrorStatus, "加载失败", MessageBoxButton.OK, MessageBoxImage.Error);
        }

        private async void CoreWebView2_WebMessageReceived(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            string requestId = string.Empty;
            try
            {
                var message = JObject.Parse(e.TryGetWebMessageAsString());
                requestId = message.Value<string>("requestId") ?? string.Empty;
                var command = message.Value<string>("command") ?? string.Empty;
                var result = await _bridge.HandleAsync(command, message["payload"]);
                Reply(new JObject { ["type"] = "response", ["requestId"] = requestId, ["ok"] = true, ["result"] = result });
            }
            catch (Exception exception)
            {
                Reply(new JObject { ["type"] = "response", ["requestId"] = requestId, ["ok"] = false, ["error"] = exception.Message });
            }
        }

        private void Reply(JObject response)
        {
            Browser.CoreWebView2?.PostWebMessageAsJson(response.ToString(Newtonsoft.Json.Formatting.None));
        }

        private void SendCommand(string command)
        {
            Reply(new JObject { ["type"] = "command", ["command"] = command });
        }

        private void NewProject_Click(object sender, RoutedEventArgs e) => SendCommand("project:new");
        private void OpenProject_Click(object sender, RoutedEventArgs e) => SendCommand("project:open");
        private void SaveProject_Click(object sender, RoutedEventArgs e) => SendCommand("project:save");
        private void SaveAsProject_Click(object sender, RoutedEventArgs e) => SendCommand("project:saveAs");
        private void Undo_Click(object sender, RoutedEventArgs e) => SendCommand("edit:undo");
        private void Redo_Click(object sender, RoutedEventArgs e) => SendCommand("edit:redo");
        private void Delete_Click(object sender, RoutedEventArgs e) => SendCommand("edit:delete");
        private void View2D_Click(object sender, RoutedEventArgs e) => SendCommand("view:2d");
        private void View3D_Click(object sender, RoutedEventArgs e) => SendCommand("view:3d");
        private void Cut_Click(object sender, RoutedEventArgs e) => Browser.ExecuteScriptAsync("document.execCommand('cut')");
        private void Copy_Click(object sender, RoutedEventArgs e) => Browser.ExecuteScriptAsync("document.execCommand('copy')");
        private void Paste_Click(object sender, RoutedEventArgs e) => SendCommand("edit:paste");
        private void Reload_Click(object sender, RoutedEventArgs e) => Browser.Reload();
        private void DevTools_Click(object sender, RoutedEventArgs e) => Browser.CoreWebView2?.OpenDevToolsWindow();
        private void Minimize_Click(object sender, RoutedEventArgs e) => WindowState = WindowState.Minimized;
        private void Exit_Click(object sender, RoutedEventArgs e) => Close();

        private void Fullscreen_Click(object sender, RoutedEventArgs e)
        {
            if (!_fullscreen)
            {
                _previousStyle = WindowStyle;
                _previousState = WindowState;
                WindowStyle = WindowStyle.None;
                WindowState = WindowState.Maximized;
            }
            else
            {
                WindowStyle = _previousStyle;
                WindowState = _previousState;
            }
            _fullscreen = !_fullscreen;
        }

        private void About_Click(object sender, RoutedEventArgs e)
        {
            MessageBox.Show(this,
                "卫星条带规划工具 0.3.2\n\n轻量核心：MapLibre、PMTiles、deck.gl、H3、SGP4\n支持任意多节点条带、中国标准地图表达和目标区域访问分析。\n\n本工具用于研究与工程规划，不用于飞控或任务安全认证。",
                "关于", MessageBoxButton.OK, MessageBoxImage.Information);
        }
    }
}
