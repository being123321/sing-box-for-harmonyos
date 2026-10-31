param(
  [Parameter(Mandatory=$true)][string]$SourceRoot,
  [Parameter(Mandatory=$true)][string]$DestinationRoot,
  [Parameter(Mandatory=$true)][string]$AlphaCoreRoot
)
$ErrorActionPreference='Stop'
$source=(Resolve-Path -LiteralPath $SourceRoot).Path
$stableVersion=(Get-Content (Join-Path $source 'AppScope/app.json5') -Raw|ConvertFrom-Json).app.versionName
if($stableVersion -notmatch '^\d+(\.\d+)+$'){throw 'Expected stable application version'}
$betaVersion=$stableVersion+'-beta'
$destination=[IO.Path]::GetFullPath($DestinationRoot)
$alpha=(Resolve-Path -LiteralPath $AlphaCoreRoot).Path
if($destination.Equals($source,[StringComparison]::OrdinalIgnoreCase) -or $destination.StartsWith($source+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Beta destination must be outside source'}
New-Item -ItemType Directory -Force $destination|Out-Null
robocopy $source $destination /E /XD .git .hvigor build out artifacts security third_party .cxx .preview /XF *.log *.jpeg *.jpg *.hap /NFL /NDL /NJH /NJS /NP|Out-Null
if($LASTEXITCODE -gt 7){throw 'Beta copy failed'}
New-Item -ItemType Directory -Force "$destination/core/go/out"|Out-Null
Copy-Item "$alpha/out/libharmonycore.so","$alpha/out/libharmonycore.h" "$destination/core/go/out"
Copy-Item "$alpha/go.mod","$alpha/go.sum","$alpha/platform_alpha.go" "$destination/core/go"
# Package identity changes are deliberately limited to these fields/files.
# In particular, encryption alias and AAD must never follow bundle renaming.
$p="$destination/AppScope/app.json5";$s=Get-Content $p -Raw
Set-Content $p ($s.Replace('"bundleName": "com.harmonynet.assistant"','"bundleName": "com.harmonynet.assistant.beta"')) -Encoding utf8
$p="$destination/entry/src/main/ets/domain/NetworkSettings.ts";$s=Get-Content $p -Raw
Set-Content $p ($s.Replace("HARMONY_NET_BUNDLE_NAME: string = 'com.harmonynet.assistant'","HARMONY_NET_BUNDLE_NAME: string = 'com.harmonynet.assistant.beta'")) -Encoding utf8
$p="$destination/entry/src/main/ets/services/ConnectionCoordinator.ts";$s=Get-Content $p -Raw
Set-Content $p ($s.Replace("catch (_) { return 'com.harmonynet.assistant' }","catch (_) { return 'com.harmonynet.assistant.beta' }")) -Encoding utf8
$p="$destination/entry/src/main/ets/core/CoreMetadataGateway.ts";$s=Get-Content $p -Raw
Set-Content $p ($s.Replace('1.14.4','1.15.0-alpha.13')) -Encoding utf8
$p="$destination/entry/src/main/ets/domain/BuildInfo.ts";$s=Get-Content $p -Raw
Set-Content $p ($s.Replace("CORE_VERSION: string = '1.14.4'", "CORE_VERSION: string = '1.15.0-alpha.13'").Replace("APP_VERSION: string = '$stableVersion'", "APP_VERSION: string = '$betaVersion'")) -Encoding utf8
$p="$destination/AppScope/app.json5";$s=Get-Content $p -Raw
Set-Content $p ($s.Replace('"versionName": "'+$stableVersion+'"','"versionName": "'+$betaVersion+'"')) -Encoding utf8
foreach($lang in @('base','en_US')){$p="$destination/AppScope/resources/$lang/element/string.json";$j=Get-Content $p -Raw|ConvertFrom-Json;foreach($v in $j.string){if($v.name -eq 'app_name'){$v.value='sing-box Beta'}};$j|ConvertTo-Json -Depth 8|Set-Content $p -Encoding utf8}
foreach($relative in @('entry/src/main/ets/services/SecureCipher.ts','entry/src/main/ets/services/SecureFileStore.ts')){
 if((Get-FileHash (Join-Path $source $relative)).Hash -ne (Get-FileHash (Join-Path $destination $relative)).Hash){throw ('Beta must not rewrite storage protocol: '+$relative)}
}
'PASS Beta storage protocol byte parity'
