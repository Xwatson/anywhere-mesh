using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;

internal static class LoginProtection {
    static int Main(string[] args) {
        if (args.Length != 1 || (args[0] != "seal" && args[0] != "open")) return 1;
        try {
            using (var input = Console.OpenStandardInput())
            using (var data = new MemoryStream()) {
                var buffer = new byte[1024];
                int count;
                while ((count = input.Read(buffer, 0, buffer.Length)) > 0) {
                    if (count + data.Length > 16384) return 1;
                    data.Write(buffer, 0, count);
                }
                var purpose = Encoding.UTF8.GetBytes("AnywhereMesh device login v1");
                var bytes = data.ToArray();
                var result = args[0] == "seal"
                    ? ProtectedData.Protect(bytes, purpose, DataProtectionScope.CurrentUser)
                    : ProtectedData.Unprotect(bytes, purpose, DataProtectionScope.CurrentUser);
                using (var output = Console.OpenStandardOutput()) output.Write(result, 0, result.Length);
            }
            return 0;
        } catch (CryptographicException) { return 2; }
        catch (Exception) { return 1; }
    }
}
