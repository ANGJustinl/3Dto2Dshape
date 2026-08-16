param(
    [string]$Emcc = ""
)

$ErrorActionPreference = 'Stop'
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$source = Join-Path $repoRoot 'native\wasm\raster_contour.cpp'
$outputDir = Join-Path $repoRoot 'public\wasm'
$output = Join-Path $outputDir 'raster_contour.js'

if (-not $Emcc) {
    $emccCommand = Get-Command em++ -ErrorAction SilentlyContinue
    if ($emccCommand) {
        $Emcc = $emccCommand.Source
    } else {
        $sdkRoots = @()
        if ($env:EMSDK) { $sdkRoots += $env:EMSDK }
        $sdkRoots += (Join-Path $repoRoot 'emsdk')
        $candidatePaths = $sdkRoots | ForEach-Object {
            @(
                (Join-Path $_ 'upstream\emscripten\em++.exe'),
                (Join-Path $_ 'upstream\emscripten\em++.bat'),
                (Join-Path $_ 'upstream\emscripten\em++.py')
            )
        }
        $candidate = $candidatePaths | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
        if ($candidate) { $Emcc = $candidate }
    }
}

if (-not $Emcc) {
    throw 'Emscripten was not found. Install emsdk and run em++ or pass -Emcc <path-to-em++.exe>.'
}

# Resolve an explicitly supplied executable without requiring a .bat suffix;
# recent emsdk releases install native em++.exe launchers on Windows.
if (-not (Get-Command $Emcc -ErrorAction SilentlyContinue) -and -not (Test-Path -LiteralPath $Emcc)) {
    throw "Emscripten compiler was not found at '$Emcc'."
}

New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
& $Emcc $source -std=c++17 -O3 -msimd128 `
    -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web -sALLOW_MEMORY_GROWTH=1 `
    -sEXPORTED_FUNCTIONS="['_malloc','_free','_rasterize_contour_batch','_raster_contour_last_error']" `
    -sEXPORTED_RUNTIME_METHODS="['UTF8ToString','HEAPF32','HEAP32','HEAPU8']" `
    -o $output
if ($LASTEXITCODE -ne 0) { throw "Emscripten build failed with exit code $LASTEXITCODE." }
Write-Output "Built $output"

$nativeCompiler = Get-Command g++ -ErrorAction SilentlyContinue
if ($nativeCompiler) {
    $smokeOutput = Join-Path $env:TEMP 'raster_contour_smoke.exe'
    & $nativeCompiler.Source -std=c++17 -O2 `
        (Join-Path $repoRoot 'native\wasm\raster_contour.cpp') `
        (Join-Path $repoRoot 'native\wasm\tests\smoke.cpp') `
        -o $smokeOutput
    if ($LASTEXITCODE -eq 0) {
        & $smokeOutput
        if ($LASTEXITCODE -ne 0) { throw 'Native raster contour smoke test failed.' }
        Write-Output 'Native raster contour smoke test passed.'
    }
}
