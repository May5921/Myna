# Windows 代码签名

Myna 的安装包目前默认未签名，Windows SmartScreen 会提示“未知发布者”。这直接影响安装转化。本文是签名配置说明，不是已经签好名的证明。

## 方案 A：Azure Trusted Signing（推荐）

electron-builder 26 原生支持 `win.azureSignOptions`。构建脚本会在以下四个环境变量都存在时自动传参：

```powershell
$env:AZURE_TRUSTED_SIGNING_ENDPOINT  = "https://<region>.codesigning.azure.net"
$env:AZURE_TRUSTED_SIGNING_PROFILE   = "<certificate-profile-name>"
$env:AZURE_TRUSTED_SIGNING_ACCOUNT   = "<code-signing-account-name>"
$env:AZURE_TRUSTED_SIGNING_PUBLISHER = "<certificate subject common name>"

# Azure Identity 认证（服务主体；CI 里用 secret）
$env:AZURE_TENANT_ID     = "<tenant-id>"
$env:AZURE_CLIENT_ID     = "<client-id>"
$env:AZURE_CLIENT_SECRET = "<client-secret>"

npm run build:installer
```

构建日志里应出现 `使用 Azure Trusted Signing: ...`。首次使用会安装 PowerShell `TrustedSigning` 模块。

前置条件：

- Azure 订阅里创建 Trusted Signing account 与 certificate profile。
- 服务主体在证书配置上有签名权限。
- 证书的 subject common name 与 `AZURE_TRUSTED_SIGNING_PUBLISHER` 一致；否则 Windows 发布者显示不对。

## 方案 B：传统 PFX / EV 证书

electron-builder 直接读取标准环境变量：

```powershell
$env:CSC_LINK = "C:\path\to\myna.pfx"
$env:CSC_KEY_PASSWORD = "<password>"
npm run build:installer
```

EV 证书通常要求 USB token/HSM，不能导出 PFX；那种情况用厂商的签名工具，或改用 Azure Trusted Signing。

## 验证

```powershell
Get-AuthenticodeSignature .\dist-installer\Myna-Setup-<version>.exe | Format-List Status,StatusMessage,SignerCertificate
```

`Status` 必须是 `Valid`。签名后仍建议保留 SHA256 校验文件：签名证明发布者，SHA256 证明下载内容完整，两者不互相替代。

## 与自动更新的关系

Myna 的更新器先校验 GitHub Release 里的 `.sha256`，再允许启动安装包。当前未签名构建只靠 SHA256 防篡改；签名后可以再加 Authenticode 校验，但这需要把“当前应用是否已签名”作为运行时判断，避免开发版/未签名版误报。

## 不要做的事

- 不要把证书、密码、Azure secret 提交到仓库或写进日志。
- 不要在未签名时对外声称“已签名/可信发布者”。
- 不要用自签名证书冒充受信任发布者；SmartScreen 仍然会拦。
