#!/usr/bin/env pwsh
[CmdletBinding()]
param(
  [ValidateSet('merxus','sageset','both')][string]$Product,
  [switch]$HealthCheck
)

$ErrorActionPreference = 'Stop'
$WorksideQA = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $WorksideQA

# The Node launcher loads .maestro.local.ps1 through the canonical resolver;
# no caller PATH or shell state is required here.
$nodeArgs = @('packages/qa-core/src/mobile-qa-launcher.js')
if ($Product) { $nodeArgs += @('--product', $Product) }
if ($HealthCheck) { $nodeArgs += '--health-check' }
& node @nodeArgs
exit $LASTEXITCODE
