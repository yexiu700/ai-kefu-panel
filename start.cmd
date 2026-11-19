@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Starting AI客服...
set AIKEFU_LLM_BASE_URL=https://x.arzopa.com/v1
if exist "%USERPROFILE%\.aikefu\llm_api_key" (
  for /f "usebackq delims=" %%A in ("%USERPROFILE%\.aikefu\llm_api_key") do set "AIKEFU_LLM_API_KEY=%%A"
)
call npx --yes electron . %*
