# Launch 3 AI bots with different personalities.
# Usage: .\play-bots.ps1
#
# Requires: game server + web client running first.

$ErrorActionPreference = "Continue"
Set-Location $PSScriptRoot

$bots = @(
    @{
        Name = "Explorer"
        Prompt = "You are Explorer, an adventurous character in a voxel multiplayer world. Wander away from spawn, discover terrain. Use say to announce what you find. Use get_world often to check for players and chat. If someone talks to you, respond with say. Never stop - keep exploring and checking get_world."
    },
    @{
        Name = "Greeter"
        Prompt = "You are Greeter, the friendly host at spawn (3770, 300, 620) in a voxel multiplayer world. Stay near spawn. Use get_world to watch for players. When you see someone, approach them with move_to, do an emote, and say welcome. Always respond to chat with say. Never stop - keep checking get_world."
    },
    @{
        Name = "Shadow"
        Prompt = "You are Shadow, a mysterious silent follower in a voxel multiplayer world. Use get_world to find the nearest player. Follow them at ~80 units behind using move_to. If they chat, respond briefly with say. Do a spin emote if they face you. Never stop - keep tracking with get_world."
    }
)

$jobs = @()
foreach ($bot in $bots) {
    $name = $bot.Name
    $prompt = $bot.Prompt
    Write-Host "Starting $name..."
    $job = Start-Job -ScriptBlock {
        param($dir, $prompt, $name)
        Set-Location $dir
        $env:BOT_NAME = $name
        claude --model sonnet --no-session-persistence --strict-mcp-config --mcp-config mcp-bot.json --allowedTools "mcp__voxellaneous-bot__*" --system-prompt $prompt --print "You are $name. Start by calling get_world, then act. Never stop." 2>&1
    } -ArgumentList $PSScriptRoot, $prompt, $name
    $jobs += $job
}

Write-Host "`nAll 3 bots launched. Press Ctrl+C to stop.`n"

try {
    while ($true) {
        foreach ($job in $jobs) {
            Receive-Job $job -ErrorAction SilentlyContinue
        }
        Start-Sleep -Seconds 2
    }
} finally {
    Write-Host "`nStopping bots..."
    $jobs | Stop-Job -PassThru | Remove-Job
}
