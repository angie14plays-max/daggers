local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local Workspace = game:GetService("Workspace")
local player = Players.LocalPlayer

local Config = loadstring(game:HttpGet("https://raw.githubusercontent.com/TU_USUARIO/TU_REPO/main/config.lua"))()

local req = (syn and syn.request) or (http and http.request) or (http_request) or (fluxus and fluxus.request) or request
if not req then return warn("No HTTP executor found") end

local seenLogs = {}

local function parseValue(txt)
    if not txt then return 0 end
    local raw = txt:gsub("[^%d%.KMBT]", "")
    local num = tonumber(raw:match("([%d%.]+)")) or 0
    if raw:match("B") then num=num*1e9
    elseif raw:match("M") then num=num*1e6
    elseif raw:match("K") then num=num*1e3 end
    return num
end

local function scanServer()
    local best = {name="N/A", value=0}
    for _, obj in pairs(Workspace:GetDescendants()) do
        if obj.Name == "AnimalOverhead" then
            local nameLabel = obj:FindFirstChild("DisplayName")
            local moneyLabel = obj:FindFirstChild("Generation")
            if nameLabel and moneyLabel then
                local val = parseValue(moneyLabel.Text)
                if val >= Config.MIN_MONEY then
                    local logKey = obj:GetFullName()
                    if not seenLogs[logKey] then
                        seenLogs[logKey] = true
                        -- enviar al backend
                        local body = HttpService:JSONEncode({
                            jobId = game.JobId,
                            name = nameLabel.Text,
                            value = val
                        })
                        pcall(function()
                            req({
                                Url = Config.BACKEND_URL,
                                Method = "POST",
                                Headers = {["Content-Type"]="application/json"},
                                Body = body
                            })
                        end)
                    end
                    if val > best.value then best = {name=nameLabel.Text, value=val} end
                end
            end
        end
    end
end

task.spawn(function()
    while true do
        scanServer()
        task.wait(Config.SCAN_RATE)
    end
end)
