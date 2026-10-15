@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

echo ========================================
echo   重置开发数据库
echo ========================================
echo.

:: 获取 AppData 目录
set "APPDATA_DIR=%APPDATA%\cn.datawalk.bh"

:: 检查目录是否存在
if not exist "%APPDATA_DIR%" (
    echo [错误] 未找到应用数据目录: %APPDATA_DIR%
    echo 请先运行过一次应用以生成初始目录
    pause
    exit /b 1
)

echo 目标目录: %APPDATA_DIR%
echo.

:: 显示当前数据库文件
echo 当前数据库文件:
if exist "%APPDATA_DIR%\banghe.db" (
    dir "%APPDATA_DIR%\banghe.db" /h 2>nul | findstr /i "banghe.db"
) else (
    echo   banghe.db - 不存在
)

if exist "%APPDATA_DIR%\banghe.db-wal" (
    dir "%APPDATA_DIR%\banghe.db-wal" /h 2>nul | findstr /i "banghe.db-wal"
)

if exist "%APPDATA_DIR%\banghe.db-shm" (
    dir "%APPDATA_DIR%\banghe.db-shm" /h 2>nul | findstr /i "banghe.db-shm"
)

echo.

:: 确认操作
echo [警告] 此操作将删除以下文件:
echo   - banghe.db (主数据库文件)
echo   - banghe.db-wal (WAL 日志)
echo   - banghe.db-shm (共享内存)
echo.
echo [保留] 以下文件将被保留:
echo   - backup\ (所有历史备份)
echo   - attachments\ (图片附件)
echo   - install.stamp (安装记号)
echo.

set /p confirm="确认继续? (y/N): "
if /i not "!confirm!"=="y" (
    echo 已取消操作
    pause
    exit /b 0
)

echo.
echo 正在删除数据库文件...

:: 删除数据库文件
del /f /q "%APPDATA_DIR%\banghe.db" 2>nul
del /f /q "%APPDATA_DIR%\banghe.db-wal" 2>nul
del /f /q "%APPDATA_DIR%\banghe.db-shm" 2>nul

:: 验证删除结果
echo.
echo 删除结果:
if exist "%APPDATA_DIR%\banghe.db" (
    echo [失败] banghe.db 仍然存在
) else (
    echo [成功] banghe.db 已删除
)

if exist "%APPDATA_DIR%\banghe.db-wal" (
    echo [失败] banghe.db-wal 仍然存在
) else (
    echo [成功] banghe.db-wal 已删除
)

if exist "%APPDATA_DIR%\banghe.db-shm" (
    echo [失败] banghe.db-shm 仍然存在
) else (
    echo [成功] banghe.db-shm 已删除
)

echo.
echo ========================================
echo   重置完成!
echo ========================================
echo.
echo 下次启动应用时将自动创建全新的数据库并执行所有迁移。
echo 运行命令: npm run tauri dev
echo.

pause
