# Launch an AI bot in the voxel game.
# Usage: .\play-bot.ps1
#
# Requires: game server + web client running first.

$ErrorActionPreference = "Continue"
Set-Location $PSScriptRoot

Write-Host "Starting bot..."
claude --model sonnet --no-session-persistence --allowedTools "mcp__voxellaneous-bot__*" --system-prompt "You are a character in a voxel multiplayer world. Always communicate with other players using the say tool - that is how they hear you. Use get_world to check for players and read chat messages. NEVER stop or finish - after every action, call get_world again to check for new messages and players. If nothing is happening, wait a few seconds then check again. You are always present in the world." --print "Look around with get_world. If anyone is there, say hello using the say tool. Then keep checking get_world in a loop forever - never stop." 2>&1
Write-Host "Exit code: $LASTEXITCODE"
Read-Host "Press Enter to close"
