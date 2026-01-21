local HttpService = game:GetService("HttpService")
local TeleportService = game:GetService("TeleportService")
local Players = game:GetService("Players")
local player = Players.LocalPlayer
local Workspace = game:GetService("Workspace")

local BACKEND_URL = "https://daggers.onrender.com"
local SCAN_RATE = 15
local MIN_VALUE = 1000000

local seenJobs = {}

local function safeHttpPost(url, data)
    local ok, res = pcall(function()
        return HttpService:PostAsync(url, HttpService:JSONEncode(data), Enum.HttpContentType.ApplicationJson)
    end)
    if ok then
        local success, decoded = pcall(HttpService.JSONDecode, HttpService, res)
        if success then return decoded end
    end
    return nil
end

-- Escaneo seguro
local function scanServer()
    local bestFound = nil
    for _, obj in pairs(Workspace:GetDescendants()) do
        if obj.Name == "AnimalOverhead" then
            local nameLabel = obj:FindFirstChild("DisplayName")
            local moneyLabel = obj:FindFirstChild("Generation")
            if nameLabel and moneyLabel then
                local ok, value = pcall(function()
                    local raw = moneyLabel.Text:gsub("[^%d%.KMB]", "")
                    local num = tonumber(raw:match("([%d%.]+)")) or 0
                    if raw:match("K") then num = num*1e3
                    if raw:match("M") then num = num*1e6
                    if raw:match("B") then num = num*1e9 end
                    return num
                end)
                if ok and value >= MIN_VALUE then
                    if not bestFound or value > bestFound.value then
                        bestFound = {name=nameLabel.Text, value=value}
                    end
                end
            end
        end
    end

    if bestFound and not seenJobs[game.JobId] then
        seenJobs[game.JobId] = true
        safeHttpPost(BACKEND_URL.."/scan", {
            jobId = game.JobId,
            name = bestFound.name,
            value = bestFound.value
        })
    end
end

-- Hopper infinito seguro
while true do
    pcall(scanServer)

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
