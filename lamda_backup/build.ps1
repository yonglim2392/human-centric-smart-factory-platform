# 💡 실행 위치는 원본 코드가 있는 'lamda_backup' 폴더입니다.
$srcDir = $PWD.Path
$parentDir = Split-Path -Path $srcDir -Parent
$lamdaDir = Join-Path -Path $parentDir -ChildPath "lamda"
$layerDir = Join-Path -Path $parentDir -ChildPath "layer\python"

Write-Host "1. 배포용 폴더(lamda, layer) 초기화 중..." -ForegroundColor Cyan
if (Test-Path "$parentDir\layer") { Remove-Item -Recurse -Force "$parentDir\layer" }
if (Test-Path $lamdaDir) { Remove-Item -Recurse -Force $lamdaDir }
New-Item -ItemType Directory -Path $layerDir -Force | Out-Null
New-Item -ItemType Directory -Path $lamdaDir -Force | Out-Null

Write-Host "2. 리눅스(Lambda) 환경에서 외부 라이브러리(Layer) 설치 중..." -ForegroundColor Cyan
# 상위 폴더를 마운트해서 lamda_backup 안의 requirements.txt를 읽어 layer/python에 설치합니다.
docker run --rm -v "$($parentDir):/workspace" -w /workspace/lamda_backup public.ecr.aws/sam/build-python3.12:latest bash -c "pip install -r requirements.txt -t /workspace/layer/python"

Write-Host "3. 컴파일을 위해 원본 파이썬 파일들을 lamda 폴더로 임시 복사 중..." -ForegroundColor Cyan
Copy-Item -Path "$srcDir\*.py" -Destination $lamdaDir -Force

Write-Host "4. 컴파일 전 난독화(Obfuscation) 공정 시작..." -ForegroundColor Yellow
# 도커 내부에서 pyarmor를 실행하여 코드를 꼬아버림
docker run --rm -v "$($srcDir):/src" -v "$($lamdaDir):/dst" -w /src public.ecr.aws/sam/build-python3.12:latest bash -c "pip install pyarmor && pyarmor gen --platform linux.x86_64 --output /dst *.py"

# Write-Host "5. AWS Lambda 환경에서 바이너리(.so) 컴파일 시작..." -ForegroundColor Cyan
# # lamda 폴더 안에서 컴파일을 수행합니다.
# docker run --rm -v "$($lamdaDir):/app" -w /app public.ecr.aws/sam/build-python3.12:latest bash -c "pip install cython && python setup.py"

Write-Host "6. lamda 폴더 내 찌꺼기 정리 및 .so 이름 최적화..." -ForegroundColor Cyan
# 컴파일이 끝났으니 lamda 폴더 안의 .py, .c, build 폴더는 삭제합니다. (원본은 lamda_backup에 안전함)
if (Test-Path "$lamdaDir\build") { Remove-Item -Recurse -Force "$lamdaDir\build" -ErrorAction SilentlyContinue }
Remove-Item -Path "$lamdaDir\setup.py" -ErrorAction SilentlyContinue
Remove-Item -Path "$lamdaDir\*.c" -ErrorAction SilentlyContinue

# 만들어진 .so 파일 이름 깔끔하게 변경
Get-ChildItem -Path $lamdaDir -Filter *.so | ForEach-Object {
    $newName = $_.Name.Split('.')[0] + '.so'
    Rename-Item -Path $_.FullName -NewName $newName -Force
}

Write-Host "[완료] 소스 코드와 배포 파일이 완벽하게 분리되었습니다!" -ForegroundColor Green
Write-Host " - lamda_backup (현재 폴더) : 원본 코드 안전하게 유지됨" -ForegroundColor Yellow
Write-Host " - lamda 폴더 : 테라폼 배포용 기계어(.so) 파일만 존재" -ForegroundColor Yellow
Write-Host " - layer/python 폴더 : 라이브러리 설치 완료" -ForegroundColor Yellow