$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
node "$scriptDir\start-chrome.mjs"
