using System.Net;
using System.Windows;

namespace Stripe.Host
{
    public partial class App : Application
    {
        protected override void OnStartup(StartupEventArgs e)
        {
            base.OnStartup(e);
            ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
            new MainWindow().Show();
        }
    }
}
