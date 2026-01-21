local cfg = loadstring(game:HttpGet("CONFIG_URL"))()
local HttpService = game:GetService("HttpService")
local Workspace = game:GetService("Workspace")

if not game:IsLoaded() then game.Loaded:Wait() end
repeat task.wait() until Workspace:FindFirstChild("Plots")

local function parseValue(txt)
    local n = tonumber(txt:match("[%d%.]+"))
    if not n then return 0 end
    if txt:find("K") then n*=1e3 end
    if txt:find("M") then n*=1e6 end
    if txt:find("B") then n*=1e9 end
    return n
end

local best = { name = nil, value = 0 }

for _, obj in ipairs(Workspace:GetDescendants()) do
    if obj.Name == "AnimalOverhead" then
        local gen = obj:FindFirstChild("Generation")
        local name = obj:FindFirstChild("DisplayName")

        if gen and name then
            local val = parseValue(gen.Text)
            if val >= cfg.MIN_VALUE and val > best.value then
                best = { name = name.Text, value = val }
            end
        end
    end
end

if best.name then
    request({
        Url = cfg.STATS_API,
        Method = "POST",
        Headers = {["Content-Type"]="application/json"},
        Body = HttpService:JSONEncode({
            jobId = game.JobId,
            name = best.name,
            value = best.value
        })
    })
end
