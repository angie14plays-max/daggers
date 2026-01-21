--// MAIN BLOSSOM SCANNER + HOPPER + STATS EMBED
--// Compatible con Seliware
--// Autor: daggers repo actualizado

if not game:IsLoaded() then
    game.Loaded:Wait()
end

local Players = game:GetService("Players")
local TeleportService = game:GetService("TeleportService")
local HttpService = game:GetService("HttpService")
local Workspace = game:GetService("Workspace")
local RunService = game:GetService("RunService")

-- CONFIG
local PLACE_ID = 109983668079237 -- Steal a Brainrot
local WEBHOOK_10M = "https://discord.com/api/webhooks/1458754235884765267/HwFdHLzFSNGjnrSCIOD3XkE66BtV3NjO90rLLgedRXmULZ2l6YNcAI2PVYUaWAlW7I3V"
local WEBHOOK_1M = "https://discord.com/api/webhooks/1458754029818744833/aM98FXJ9Yksoo1FNamrLJfOhXT2Eefcfw2tvA36m-OM1G3SmbQl4Urid185Tu2S-xzSV"
local STATS_WEBHOOK = "TU_WEBHOOK_STATS_AQUI"
local SCAN_RATE = 15 -- segundos entre escaneos
local MIN_PAID = 10000000
local MIN_FREE = 1000000

-- HOPPER CONFIG
local hopCooldown = 3
local lastJobId = nil
local seenJobs = {}

-- STATS
local serversToday = 0
local serversLastMinute = 0
local startTime = tick()
local bestToday = {name="N/A", value=0}

-- UTIL
local function parseValue(txt)
    local raw = txt:gsub("[^%d%.KMBT]", "")
    local num = tonumber(raw:match("([%d%.]+)")) or 0
    if raw:match("B") then num=num*1e9
    elseif raw:match("M") then num=num*1e6
    elseif raw:match("K") then num=num*1e3 end
    return num
end

local function sendWebhook(url, data)
    pcall(function()
        HttpService:PostAsync(url, HttpService:JSONEncode(data), Enum.HttpContentType.ApplicationJson)
    end)
end

-- BLOSSOM SCANNER
local function scanServer()
    local inventoryPaid = {}
    local inventoryFree = {}

    for _, obj in pairs(Workspace:GetDescendants()) do
        if obj.Name == "AnimalOverhead" then
            local nameLabel = obj:FindFirstChild("DisplayName")
            local moneyLabel = obj:FindFirstChild("Generation")
            local rarityLabel = obj:FindFirstChild("Rarity")

            if nameLabel and moneyLabel then
                local realName = nameLabel.Text
                local rawVal = moneyLabel.Text
                local totalVal = parseValue(rawVal)

                if rarityLabel and rarityLabel.Text ~= "" then
                    realName = "["..rarityLabel.Text.."] " .. realName
                end

                local brainrotData = {
                    name = realName,
                    value = totalVal,
                    jobId = game.JobId,
                    placeId = game.PlaceId,
                    link = "https://www.roblox.com/games/"..game.PlaceId.."/"..game.JobId
                }

                if totalVal >= MIN_PAID then
                    table.insert(inventoryPaid, brainrotData)
                elseif totalVal >= MIN_FREE then
                    table.insert(inventoryFree, brainrotData)
                end

                -- actualizar mejor hoy
                if totalVal > bestToday.value then
                    bestToday = {name=realName, value=totalVal}
                end
            end
        end
    end

    -- enviar logs Blossom Paid
    for _, b in pairs(inventoryPaid) do
        if not seenJobs[b.jobId..b.name] then
            sendWebhook(WEBHOOK_10M, {
                content = "**[PAID] "..b.name.."** → "..b.value.." M/s\n"..b.link
            })
            seenJobs[b.jobId..b.name] = true
        end
    end

    -- enviar logs Blossom Free
    for _, b in pairs(inventoryFree) do
        if not seenJobs[b.jobId..b.name] then
            sendWebhook(WEBHOOK_1M, {
                content = "**[FREE] "..b.name.."** → "..b.value.." M/s\n"..b.link
            })
            seenJobs[b.jobId..b.name] = true
        end
    end

    serversToday = serversToday + 1
    serversLastMinute = serversLastMinute + 1
end

-- HOPPER
local function hopServer()
    local success, response = pcall(function()
        if lastJobId then
            TeleportService:TeleportToPlaceInstance(PLACE_ID, lastJobId, Players.LocalPlayer)
        else
            TeleportService:Teleport(PLACE_ID, Players.LocalPlayer)
        end
    end)
    if not success then
        warn("Teleport falló, reintentando en "..hopCooldown.."s")
        task.wait(hopCooldown)
        hopServer()
    end
end

-- STATS EMBED
local function updateStats()
    local elapsed = tick() - startTime
    local embed = {
        title = "🤖 Bot Stats - Steal a Brainrot",
        color = 0x00ffaa,
        description = string.format(
            "Tiempo activo: %d min\nServidores hoy: %d\nServers / min: %d\nMejor brainrot: %s → %d M/s",
            math.floor(elapsed/60),
            serversToday,
            serversLastMinute,
            bestToday.name,
            bestToday.value
        ),
        timestamp = os.date("!%Y-%m-%dT%H:%M:%SZ", os.time())
    }
    sendWebhook(STATS_WEBHOOK, embed)
    serversLastMinute = 0
end

-- LOOP PRINCIPAL
task.spawn(function()
    while true do
        scanServer()
        task.wait(SCAN_RATE)
    end
end)

task.spawn(function()
    while true do
        updateStats()
        task.wait(10)
    end
end)

task.spawn(function()
    while true do
        hopServer()
        task.wait(5)
    end
end)
