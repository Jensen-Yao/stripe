using Microsoft.Win32;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows;

namespace Stripe.Host
{
    internal sealed class DesktopBridge
    {
        private readonly Window _owner;
        private static readonly HttpClient PublicClient = new HttpClient { Timeout = TimeSpan.FromSeconds(20) };

        static DesktopBridge()
        {
            PublicClient.DefaultRequestHeaders.UserAgent.ParseAdd("Stripe/0.3.7 satellite-planning-workbench");
        }

        public DesktopBridge(Window owner)
        {
            _owner = owner;
        }

        public async Task<JToken> HandleAsync(string command, JToken payload)
        {
            switch (command)
            {
                case "project:save": return SaveProject(payload as JObject);
                case "project:open": return OpenProject();
                case "orbit:chooseFile": return ChooseOrbitFile(payload?.Value<string>("type"));
                case "tle:fetchCelesTrak": return await FetchCelesTrakAsync(payload as JObject);
                case "tle:fetchSpaceTrack": return await FetchSpaceTrackAsync(payload as JObject);
                case "tle:saveCredentials": return SaveCredentials(payload as JObject);
                case "tle:clearCredentials": return ClearCredentials();
                case "map:getAmapConfig": return GetAmapConfig();
                case "map:chooseAmapConfig": return ChooseAmapConfig();
                case "map:clearAmapConfig": return ClearAmapConfig();
                case "science:update": return new JObject { ["updated"] = false, ["coreMode"] = true };
                default: throw new InvalidOperationException("未知桌面命令：" + command);
            }
        }

        private JToken SaveProject(JObject payload)
        {
            if (payload == null || payload["snapshot"] == null) throw new InvalidOperationException("项目快照为空");
            var filePath = payload.Value<string>("filePath");
            if (string.IsNullOrWhiteSpace(filePath))
            {
                var dialog = new SaveFileDialog
                {
                    Title = "保存 Stripe 项目",
                    Filter = "Stripe 项目 (*.stripeproj)|*.stripeproj",
                    DefaultExt = ".stripeproj",
                    AddExtension = true,
                    FileName = "未命名.stripeproj"
                };
                if (dialog.ShowDialog(_owner) != true) return new JObject { ["canceled"] = true };
                filePath = dialog.FileName;
            }

            var directory = Path.GetDirectoryName(filePath);
            if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
            var temporary = filePath + ".tmp";
            using (var stream = File.Create(temporary))
            using (var archive = new ZipArchive(stream, ZipArchiveMode.Create))
            {
                WriteEntry(archive, "manifest.json", new JObject
                {
                    ["format"] = "stripe-project",
                    ["schemaVersion"] = payload["snapshot"].Value<int?>("schemaVersion") ?? 1,
                    ["appVersion"] = "0.3.7",
                    ["savedAt"] = DateTime.UtcNow.ToString("O")
                }.ToString(Formatting.None));
                WriteEntry(archive, "project.json", payload["snapshot"].ToString(Formatting.None));
            }
            if (File.Exists(filePath)) File.Replace(temporary, filePath, null);
            else File.Move(temporary, filePath);
            return new JObject { ["canceled"] = false, ["filePath"] = filePath };
        }

        private static void WriteEntry(ZipArchive archive, string name, string content)
        {
            var entry = archive.CreateEntry(name, CompressionLevel.Optimal);
            using (var writer = new StreamWriter(entry.Open(), new UTF8Encoding(false))) writer.Write(content);
        }

        private JToken OpenProject()
        {
            var dialog = new OpenFileDialog
            {
                Title = "打开 Stripe 项目",
                Filter = "Stripe 项目 (*.stripeproj)|*.stripeproj",
                Multiselect = false,
                CheckFileExists = true
            };
            if (dialog.ShowDialog(_owner) != true) return new JObject { ["canceled"] = true };
            using (var archive = ZipFile.OpenRead(dialog.FileName))
            {
                var entry = archive.GetEntry("project.json");
                if (entry == null) throw new InvalidDataException("项目文件缺少 project.json");
                using (var reader = new StreamReader(entry.Open(), Encoding.UTF8))
                {
                    return new JObject
                    {
                        ["canceled"] = false,
                        ["filePath"] = dialog.FileName,
                        ["snapshot"] = JToken.Parse(reader.ReadToEnd())
                    };
                }
            }
        }

        private JToken ChooseOrbitFile(string type)
        {
            var normalized = string.IsNullOrWhiteSpace(type) ? "txt" : type.ToLowerInvariant();
            var dialog = new OpenFileDialog
            {
                Title = "选择 " + normalized.ToUpperInvariant() + " 轨道文件",
                Filter = "轨道文件 (*." + normalized + ";*.txt;*.xml;*.json)|*." + normalized + ";*.txt;*.xml;*.json|所有文件 (*.*)|*.*",
                Multiselect = false,
                CheckFileExists = true
            };
            return dialog.ShowDialog(_owner) == true
                ? new JObject { ["canceled"] = false, ["filePath"] = dialog.FileName, ["fileName"] = Path.GetFileName(dialog.FileName) }
                : new JObject { ["canceled"] = true };
        }

        private async Task<JToken> FetchCelesTrakAsync(JObject query)
        {
            var parameters = new List<string> { "FORMAT=TLE" };
            var norad = query?.Value<string>("noradId")?.Trim();
            var search = query?.Value<string>("search")?.Trim();
            var group = query?.Value<string>("group")?.Trim();
            if (!string.IsNullOrWhiteSpace(norad)) parameters.Add("CATNR=" + Uri.EscapeDataString(norad));
            else if (!string.IsNullOrWhiteSpace(search)) parameters.Add("NAME=" + Uri.EscapeDataString(search));
            else parameters.Add("GROUP=" + Uri.EscapeDataString(string.IsNullOrWhiteSpace(group) ? "stations" : group));
            var text = await PublicClient.GetStringAsync("https://celestrak.org/NORAD/elements/gp.php?" + string.Join("&", parameters));
            return ParseTle(text, "celestrak");
        }

        private async Task<JToken> FetchSpaceTrackAsync(JObject query)
        {
            var credentials = ReadCredentials();
            if (credentials == null) throw new InvalidOperationException("尚未保存 Space-Track 账号");
            var cookies = new CookieContainer();
            using (var handler = new HttpClientHandler { CookieContainer = cookies, UseCookies = true, AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate })
            using (var client = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(30) })
            {
                client.DefaultRequestHeaders.UserAgent.ParseAdd("Stripe/0.3.7 satellite-planning-workbench");
                var form = new FormUrlEncodedContent(new Dictionary<string, string>
                {
                    ["identity"] = credentials.Value<string>("username"),
                    ["password"] = credentials.Value<string>("password")
                });
                var login = await client.PostAsync("https://www.space-track.org/ajaxauth/login", form);
                if (!login.IsSuccessStatusCode) throw new InvalidOperationException("Space-Track 登录失败：HTTP " + (int)login.StatusCode);
                var norad = query?.Value<string>("noradId")?.Trim();
                var search = query?.Value<string>("search")?.Trim();
                var constraint = !string.IsNullOrWhiteSpace(norad)
                    ? "NORAD_CAT_ID/" + Uri.EscapeDataString(norad)
                    : !string.IsNullOrWhiteSpace(search) ? "OBJECT_NAME/" + Uri.EscapeDataString(search.ToUpperInvariant()) + "~~" : "DECAYED/0";
                var text = await client.GetStringAsync("https://www.space-track.org/basicspacedata/query/class/gp/" + constraint + "/orderby/EPOCH desc/format/tle");
                return new JArray(ParseTle(text, "spacetrack").Take(100));
            }
        }

        private static JArray ParseTle(string text, string source)
        {
            var lines = text.Split(new[] { "\r\n", "\n" }, StringSplitOptions.RemoveEmptyEntries).Select(line => line.Trim()).Where(line => line.Length > 0).ToArray();
            var records = new JArray();
            for (var index = 0; index < lines.Length; index++)
            {
                var name = lines[index];
                var unnamed = name.StartsWith("1 ", StringComparison.Ordinal);
                var line1 = unnamed ? name : index + 1 < lines.Length ? lines[index + 1] : string.Empty;
                var line2 = unnamed ? index + 1 < lines.Length ? lines[index + 1] : string.Empty : index + 2 < lines.Length ? lines[index + 2] : string.Empty;
                if (!line1.StartsWith("1 ", StringComparison.Ordinal) || !line2.StartsWith("2 ", StringComparison.Ordinal)) continue;
                var noradId = line1.Length >= 7 ? line1.Substring(2, 5).Trim() : string.Empty;
                records.Add(new JObject
                {
                    ["name"] = unnamed ? "SAT " + noradId : name,
                    ["noradId"] = noradId,
                    ["line1"] = line1,
                    ["line2"] = line2,
                    ["source"] = source,
                    ["fetchedAt"] = DateTime.UtcNow.ToString("O")
                });
                index += unnamed ? 1 : 2;
            }
            return records;
        }

        private static string CredentialsPath => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Stripe", "spacetrack.credentials");

        private static JToken SaveCredentials(JObject credentials)
        {
            if (credentials == null || string.IsNullOrWhiteSpace(credentials.Value<string>("username")) || string.IsNullOrWhiteSpace(credentials.Value<string>("password")))
                throw new InvalidOperationException("账号或密码为空");
            Directory.CreateDirectory(Path.GetDirectoryName(CredentialsPath));
            var encrypted = ProtectedData.Protect(Encoding.UTF8.GetBytes(credentials.ToString(Formatting.None)), null, DataProtectionScope.CurrentUser);
            File.WriteAllBytes(CredentialsPath, encrypted);
            return new JObject { ["saved"] = true };
        }

        private static JObject ReadCredentials()
        {
            try
            {
                var decrypted = ProtectedData.Unprotect(File.ReadAllBytes(CredentialsPath), null, DataProtectionScope.CurrentUser);
                return JObject.Parse(Encoding.UTF8.GetString(decrypted));
            }
            catch { return null; }
        }

        private static JToken ClearCredentials()
        {
            if (File.Exists(CredentialsPath)) File.Delete(CredentialsPath);
            return new JObject { ["cleared"] = true };
        }

        private static string AmapCredentialsPath => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Stripe", "amap.credentials");

        private JToken GetAmapConfig()
        {
            var stored = ReadAmapCredentials();
            if (stored != null) return AmapConfigurationResult(stored, "本机加密配置");

            foreach (var path in AmapConfigurationCandidates())
            {
                var imported = TryReadAmapConfiguration(path);
                if (imported == null) continue;
                SaveAmapCredentials(imported);
                return AmapConfigurationResult(imported, "已从本机 API 文件自动导入");
            }
            return new JObject { ["configured"] = false };
        }

        private JToken ChooseAmapConfig()
        {
            var dialog = new OpenFileDialog
            {
                Title = "选择高德地图 Web JS API 配置",
                Filter = "文本配置 (*.txt)|*.txt|所有文件 (*.*)|*.*",
                Multiselect = false,
                CheckFileExists = true
            };
            if (dialog.ShowDialog(_owner) != true) return new JObject { ["configured"] = false, ["canceled"] = true };
            var configuration = TryReadAmapConfiguration(dialog.FileName);
            if (configuration == null) throw new InvalidDataException("配置文件中未找到有效的高德地图 Key 和安全密钥");
            SaveAmapCredentials(configuration);
            return new JObject { ["configured"] = true, ["canceled"] = false, ["source"] = "本机加密配置" };
        }

        private static IEnumerable<string> AmapConfigurationCandidates()
        {
            var fromEnvironment = Environment.GetEnvironmentVariable("STRIPE_AMAP_CONFIG");
            if (!string.IsNullOrWhiteSpace(fromEnvironment)) yield return fromEnvironment;
            yield return @"D:\Desktop\bot\api\高德地图api\web JS api.txt";
            yield return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Desktop", "bot", "api", "高德地图api", "web JS api.txt");
        }

        private static JObject TryReadAmapConfiguration(string path)
        {
            try
            {
                if (string.IsNullOrWhiteSpace(path) || !File.Exists(path)) return null;
                var text = File.ReadAllText(path, Encoding.UTF8);
                var values = Regex.Matches(text, @"(?<![A-Za-z0-9])[A-Za-z0-9_-]{24,64}(?![A-Za-z0-9])")
                    .Cast<Match>()
                    .Select(match => match.Value)
                    .Distinct(StringComparer.Ordinal)
                    .Take(2)
                    .ToArray();
                if (values.Length < 2) return null;
                return new JObject { ["key"] = values[0], ["securityCode"] = values[1] };
            }
            catch { return null; }
        }

        private static void SaveAmapCredentials(JObject configuration)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(AmapCredentialsPath));
            var encrypted = ProtectedData.Protect(Encoding.UTF8.GetBytes(configuration.ToString(Formatting.None)), null, DataProtectionScope.CurrentUser);
            File.WriteAllBytes(AmapCredentialsPath, encrypted);
        }

        private static JObject ReadAmapCredentials()
        {
            try
            {
                var decrypted = ProtectedData.Unprotect(File.ReadAllBytes(AmapCredentialsPath), null, DataProtectionScope.CurrentUser);
                var configuration = JObject.Parse(Encoding.UTF8.GetString(decrypted));
                return string.IsNullOrWhiteSpace(configuration.Value<string>("key")) || string.IsNullOrWhiteSpace(configuration.Value<string>("securityCode"))
                    ? null
                    : configuration;
            }
            catch { return null; }
        }

        private static JObject AmapConfigurationResult(JObject configuration, string source)
        {
            return new JObject
            {
                ["configured"] = true,
                ["key"] = configuration.Value<string>("key"),
                ["securityCode"] = configuration.Value<string>("securityCode"),
                ["source"] = source
            };
        }

        private static JToken ClearAmapConfig()
        {
            if (File.Exists(AmapCredentialsPath)) File.Delete(AmapCredentialsPath);
            return new JObject { ["cleared"] = true };
        }
    }
}
