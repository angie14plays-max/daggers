local TeleportService = game:GetService("TeleportService")
local Players = game:GetService("Players")
local HttpService = game:GetService("HttpService")
local player = Players.LocalPlayer

local Config = loadstring(game:HttpGet("https://raw.githubusercontent.com/TU_USUARIO/TU_REPO/main/config.lua"))()
local BACKEND_BLACKLIST = "http://127.0.0.1:3000/is-blacklisted"

local function teleportToSafeServer()
    local success, err = pcall(function()
        local servers = HttpService:JSONDecode(game:HttpGet(
            ("https://games.roblox.com/v1/games/%d/servers/Public?limit=100"):format(Config.PLACE_ID)
        ))
        local chosen
        for _, s in ipairs(servers.data or {}) do
            local free = s.maxPlayers - s.playing
            local isPrivate = (s.accessType or ""):lower():find("private")
            if free > 0 and not isPrivate then
                -- check blacklist backend
                local res = HttpService:JSONDecode(game:HttpGet(BACKEND_BLACKLIST .. "?jobId="..s.id))
                if not res.blacklisted then
                    chosen = s.id
                    break
                end
            end
        end
        if chosen then
            TeleportService:TeleportToPlaceInstance(Config.PLACE_ID, chosen, player)
        else
            warn("No server available, retrying...")
        end
    end)
    if not success then
        warn("Teleport error:", err)
    end
end

task.spawn(function()
    while true do
        teleportToSafeServer()
        task.wait(1.2) -- espera rápido antes del siguiente hop
    end
end)
