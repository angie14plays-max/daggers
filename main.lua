-- Main.lua — Hopper + Scanner + Stats compatible SeliWare
-- ==========================================
if not game:IsLoaded() then
    game.Loaded:Wait()
end

local Players = game:GetService("Players")
local TeleportService = game:GetService("TeleportService")
local HttpService = game:GetService("HttpService")
local Workspace = game:GetService("Workspace")

local player = Players.LocalPlayer
local PLACE_ID = 109983668079237 -- Steal a Brainrot
local SCAN_RATE = 20 -- segundos entre scans
local MIN_MONEY = 1000000

-- Webhook stats
local STATS_WEBHOOK = "https://daggers.onrender.com/scan" -- tu backend
local BOT_STATS_WEBHOOK = "https://discord.com/api/webhooks/1463519336718274585/7eYIZQje2I9agKr7Em3jEp7YBT8--h2IloCZo9pFBiW1YTZkcK3bRWESF-CTvJF2l3EU"

-- HTTP request compatible SeliWare
local function httpRequest(opts)
    if request then
        return request(opts)
    elseif HttpGet then
        local success, res = pcall(function()
            return HttpGet(opts.Url)
        end)
        if success then return {Body = res, StatusCode = 200} end
    end
    return nil
end

-- TRACKERS
local scannedToday = 0
local scannedThisMinute = 0
local seenJobs = {}
local seenBrainrots = {}
local bestToday = {name="N/A", value=0}

-- Reset diario
spawn(function()
    while true do
        task.wait(24*60*60)
        scannedToday = 0
        bestToday = {name="N/A", value=0}
        seenJobs = {}
        seenBrainrots = {}
    end
end)

-- Reset cada minuto
spawn(function()
    while true do
        task.wait(60)
        scannedThisMinute = 0

        -- enviar stats al webhook de Discord
        if BOT_STATS_WEBHOOK then
            local embed = {
                title = "🤖 Brainrot Bot Stats",
                color = 0x00ffaa,
                fields = {
                    {name="Servers / min", value=tostring(scannedThisMinute), inline=true},
                    {name="Servers hoy", value=tostring(scannedToday), inline=true},
                    {name="Mejor Brainrot", value=bestToday.name, inline=false},
                    {name="Producción", value=bestToday.value > 0 and (bestToday.value.."/s") or "N/A", inline=false}
                },
                timestamp = os.date("!%Y-%m-%dT%H:%M:%SZ")
            }

            pcall(function()
                httpRequest({
                    Url = BOT_STATS_WEBHOOK,
                    Method = "POST",
                    Headers = {["Content-Type"]="application/json"},
                    Body = HttpService:JSONEncode({embeds={embed}})
                })
            end)
        end
    end
end)

-- PARSE MONEY STRING
local function parseValue(txt)
    if not txt then return 0 end
    local raw = txt:gsub("[^%d%.KMBT]", "")
    local num = tonumber(raw:match("([%d%.]+)")) or 0
    if raw:match("B") then num=num*1e9
    elseif raw:match("M") then num=num*1e6
    elseif raw:match("K") then num=num*1e3 end
    return num
end

-- SCANNER SEGURO
local function BloodScan()
    local inventory = {}

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
                    realName = "["..rarityLabel.Text.."] "..realName
                end

                if totalVal >= MIN_MONEY then
                    if not seenBrainrots[realName] then
                        seenBrainrots[realName] = true
                        table.insert(inventory, {name=realName.." (Public)", value=totalVal})
                        print(" RASTRO: "..realName.." -> "..rawVal)
                        -- enviar al backend stats
                        pcall(function()
                            httpRequest({
                                Url = STATS_WEBHOOK,
                                Method = "POST",
                                Headers = {["Content-Type"]="application/json"},
                                Body = HttpService:JSONEncode({
                                    jobId = tostring(game.JobId),
                                    name = realName,
                                    value = totalVal
                                })
                            })
                        end)

                        -- actualizar mejor hoy
                        if totalVal > bestToday.value then
                            bestToday = {name=realName, value=totalVal}
                        end
                    end
                end
            end
        end
    end

    scannedToday = scannedToday + 1
    scannedThisMinute = scannedThisMinute + 1
end

-- HOPPER INFINITO (evitando servidores llenos o privados)
local function HopLoop()
    while true do
        local success, err = pcall(function()
            TeleportService:Teleport(PLACE_ID, player)
        end)
        if not success then
            warn("Teleport falló, reintentando hop: "..tostring(err))
        end
        task.wait(3)
    end
end

-- CORRER SCANNER INFINITO
spawn(function()
    while true do
        BloodScan()
        task.wait(SCAN_RATE)
    end
end)

-- INICIAR HOPPER
HopLoop()
