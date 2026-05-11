$webDir = $PWD.Path
$distDir = Join-Path -Path $webDir -ChildPath "dist"

Write-Host "0. 배포용 dist 폴더 초기화..." -ForegroundColor Cyan
if (Test-Path $distDir) { Remove-Item -Recurse -Force $distDir }
New-Item -ItemType Directory -Path $distDir -Force | Out-Null

Write-Host "1. JavaScript 강력 난독화(Obfuscation) 시작..." -ForegroundColor Cyan
docker run --rm -v "$($webDir):/app" -w /app node:18-alpine npx javascript-obfuscator app.js --output dist/app.min.js --compact true --control-flow-flattening true --string-array true --string-array-encoding 'base64' --disable-console-output true

Write-Host "2. CSS 코드 압축(Minify) 시작..." -ForegroundColor Cyan
docker run --rm -v "$($webDir):/app" -w /app node:18-alpine npx clean-css-cli -o dist/style.min.css style.css

Write-Host "3. HTML <body> 및 태그 압축(Minify) 시작..." -ForegroundColor Cyan
# 💡 주석(--remove-comments), 공백 및 줄바꿈(--collapse-whitespace)을 모두 제거하여 한 줄로 뭉갬
docker run --rm -v "$($webDir):/app" -w /app node:18-alpine npx html-minifier-terser --collapse-whitespace --remove-comments --remove-optional-tags --remove-redundant-attributes index.html -o dist/index.html

Write-Host "4. 프론트엔드 빌드 완료!" -ForegroundColor Green
Write-Host "💡 이제 새로 생성된 [dist] 폴더 안에 있는 파일들만 S3 버킷에 업로드하세요." -ForegroundColor Yellow