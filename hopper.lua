local cfg = loadstring(game:HttpGet("CONFIG_URL"))()
local TeleportService = game:GetService("TeleportService")
local Players = game:GetService("Players")
local HttpService = game:GetService("HttpService")

local player = Players.LocalPlayer
local visited = {}

local function getServers()
    local res = request({
        Url = "https://games.roblox.com/v1/games/"..cfg.PLACE_ID.."/servers/Public?limit=100",
        Method = "GET"
    })
    return HttpService:JSONDecode(res.Body).data
end

TeleportService.TeleportInitFailed:Connect(function()
    task.wait(cfg.HOP_DELAY)
end)

while true do
    local servers = getServers()
    for _, s in ipairs(servers) do
        if not visited[s.id] and (s.maxPlayers - s.playing) >= 2 then
            visited[s.id] = true
            TeleportService:TeleportToPlaceInstance(cfg.PLACE_ID, s.id, player)
            task.wait(10)
            break
        end
    end
    task.wait(cfg.HOP_DELAY)
end
