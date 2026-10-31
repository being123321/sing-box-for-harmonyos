param(
 [Parameter(Mandatory=$true)][string]$DevEcoRoot,
 [Parameter(Mandatory=$true)][string]$HvigorCli,
 [string]$NodeExecutable='node'
)
$ErrorActionPreference='Stop'
$project=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$sdk=(Resolve-Path -LiteralPath $DevEcoRoot).Path
$cli=(Resolve-Path -LiteralPath $HvigorCli).Path
$env:JAVA_HOME=Join-Path $sdk 'jbr'
$env:DEVECO_SDK_HOME=Join-Path $sdk 'sdk'
$env:PATH="$sdk/tools/node;$sdk/tools/node/bin;$sdk/tools/ohpm/bin;$env:JAVA_HOME/bin;$env:PATH"
$env:NODE_PATH=Split-Path (Split-Path (Split-Path (Split-Path $cli)))
Push-Location $project
try {
 & $NodeExecutable $cli assembleHap --mode module -p product=default -p module=entry@default -p buildMode=release --no-daemon
 if($LASTEXITCODE -ne 0){throw 'Release HAP build failed'}
 & $NodeExecutable "$PSScriptRoot/verify-hap-compression.mjs" "$project/entry/build/default/outputs/default/entry-default-unsigned.hap"
 if($LASTEXITCODE -ne 0){throw 'Release blocked: HAP native libraries must be compressed'}
} finally {Pop-Location}
