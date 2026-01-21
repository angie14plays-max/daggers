-- Main.lua — CLIENTE HOP + SCANNER

local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local TeleportService = game:GetService("TeleportService")
local player = Players.LocalPlayer

local BACKEND_URL = "https://daggers.onrender.com"
local SCAN_RATE = 20
local MIN_VALUE = 1000000

local scannedJobs = {} -- evitar logs repetidos

local function safeHttpPost(url, data)
    local body = HttpService:JSONEncode(data)
    local ok, res = pcall(function()
        return game:GetService("HttpService"):PostAsync(url, body, Enum.HttpContentType.ApplicationJson)
    end)
    if ok then
        return HttpService:JSONDecode(res)
    end
    return nil
end

-- Escaneo del server actual
local function scanServer()
    local bestFound = nil
    for _, obj in pairs(workspace:GetDescendants()) do
        if obj.Name == "AnimalOverhead" then
            local nameLabel = obj:FindFirstChild("DisplayName")
            local moneyLabel = obj:FindFirstChild("Generation")
            if nameLabel and moneyLabel then
                local rawVal = moneyLabel.Text:gsub("[^%d%.KMB]", "")
                local numVal = tonumber(rawVal:match("([%d%.]+)")) or 0
                if rawVal:match("K") then numVal = numVal * 1e3
                elseif rawVal:match("M") then numVal = numVal * 1e6
                elseif rawVal:match("B") then numVal = numVal * 1e9 end
                if numVal >= MIN_VALUE then
                    if not bestFound or numVal > bestFound.value then
                        bestFound = {name=nameLabel.Text, value=numVal}
                    end
                end
            end
        end
    end
    if bestFound then
        safeHttpPost(BACKEND_URL.."/scan", {
            jobId = game.JobId,
            name = bestFound.name,
            value = bestFound.value
        })
    end
end

-- Hop infinito
while true do
    scanServer()

    -- pedir server nuevo al backend
    local serverData = safeHttpPost(BACKEND_URL.."/next-server", {
        currentJobId = game.JobId
    })
    local nextJob = serverData and serverData.jobId

    if nextJob and nextJob ~= game.JobId then
        local success, err = pcall(function()
            TeleportService:TeleportToPlaceInstance(game.PlaceId, nextJob, player)
        end)
        if not success then
            warn("Teleport failed, retrying hop:", err)
        end
    end

    task.wait(SCAN_RATE)
end
