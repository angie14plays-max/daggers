if not game:IsLoaded() then game.Loaded:Wait() end

local HttpService = game:GetService("HttpService")
local TeleportService = game:GetService("TeleportService")
local Players = game:GetService("Players")

local player = Players.LocalPlayer
local PLACE_ID = game.PlaceId
local API = "https://TU_RENDER.onrender.com/next-server"

-- memoria local (solo sesión)
_G.VisitedServers = _G.VisitedServers or {}
_G.VisitedServers[game.JobId] = true

TeleportService.TeleportInitFailed:Connect(function(p)
    if p == player then
        warn("TP falló, reintentando...")
    end
end)

task.spawn(function()
    while true do
        local ok, res = pcall(function()
            return HttpService:PostAsync(API, "{}", Enum.HttpContentType.ApplicationJson)
        end)

        if ok then
            local data = HttpService:JSONDecode(res)
            if data.jobId and not _G.VisitedServers[data.jobId] then
                _G.VisitedServers[data.jobId] = true
                pcall(function()
                    TeleportService:TeleportToPlaceInstance(
                        PLACE_ID,
                        data.jobId,
                        player
                    )
                end)
                return
            end
        end

        task.wait(1) -- hop infinito
    end
end)
