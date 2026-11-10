@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Starting AI客服...
set NEXTOP_LLM_BASE_URL=https://x.arzopa.com/v1
if exist "%USERPROFILE%\.huiyou\llm_api_key" (
  for /f "usebackq delims=" %%A in ("%USERPROFILE%\.huiyou\llm_api_key") do set "HUIYOU_LLM_API_KEY=%%A"
  set "NEXTOP_LLM_API_KEY=%HUIYOU_LLM_API_KEY%"
)
call npx --yes electron . %*
