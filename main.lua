-- MAIN.LUA - ROBLOX EXECUTOR
-- Aggressive Hopper + Scanner for Steal a Brainrot
-- Backend: https://daggers.onrender.com

local HttpService = game:GetService("HttpService")
local TeleportService = game:GetService("TeleportService")
local Players = game:GetService("Players")
local Workspace = game:GetService("Workspace")

local player = Players.LocalPlayer
local PLACE_ID = game.PlaceId
local BACKEND_URL = "https://daggers.onrender.com"

-- Configuración de Hop
local MIN_FREE_SLOTS = 1  -- Requerido para evitar full servers
local HOP_DELAY = 0.15    -- Delay entre reintentos de hop

-- Cache de servers visitados para no repetir logs
local visitedJobs = {}
local bestBrainrotToday = {name = "N/A", value = 0}

-- Teleport Failure Detection
local teleportFailed = false
TeleportService.TeleportInitFailed:Connect(function(plr)
	if plr == player then
		teleportFailed = true
	end
end)

-- Función para enviar scan al backend
local function sendScan(jobId, name, value)
	if visitedJobs[jobId] then return end
	visitedJobs[jobId] = true

	local data = {
		jobId = jobId,
		name = name,
		value = value
	}

	pcall(function()
		HttpService:PostAsync(
			BACKEND_URL .. "/scan",
			HttpService:JSONEncode(data),
			Enum.HttpContentType.ApplicationJson
		)
	end)

	-- Actualiza el mejor brainrot del día
	if value > bestBrainrotToday.value then
		bestBrainrotToday.name = name
		bestBrainrotToday.value = value
	end
end

-- Parsear valores tipo "1.5M", "100K"
local function parseValue(txt)
	if not txt then return 0 end
	local raw = txt:gsub("[^%d%.KMBT]", "")
	local num = tonumber(raw:match("([%d%.]+)")) or 0
	if raw:match("B") then num = num * 1e9
	elseif raw:match("M") then num = num * 1e6
	elseif raw:match("K") then num = num * 1e3 end
	return num
end

-- Función para escanear Brainrots en el server actual
local function scanServer()
	for _, obj in pairs(Workspace:GetDescendants()) do
		if obj.Name == "AnimalOverhead" then
			local nameLabel = obj:FindFirstChild("DisplayName")
			local moneyLabel = obj:FindFirstChild("Generation")
			local rarityLabel = obj:FindFirstChild("Rarity")

			if nameLabel and moneyLabel then
				local nameStr = nameLabel.Text
				if rarityLabel and rarityLabel.Text ~= "" then
					nameStr = "["..rarityLabel.Text.."] "..nameStr
				end

				local value = parseValue(moneyLabel.Text)
				if value > 0 then
					sendScan(game.JobId, nameStr, value)
				end
			end
		end
	end
end

-- Función para conseguir un servidor válido desde el backend
local function getNextServer()
	local success, response = pcall(function()
		return HttpService:PostAsync(
			BACKEND_URL .. "/next-server",
			HttpService:JSONEncode({ placeId = PLACE_ID, currentJobId = game.JobId }),
			Enum.HttpContentType.ApplicationJson
		)
	end)

	if success and response then
		local ok, decoded = pcall(HttpService.JSONDecode, HttpService, response)
		if ok and decoded and decoded.jobId and decoded.jobId ~= "" then
			return decoded.jobId
		end
	end
	return nil
end

-- Función de teleport seguro
local function safeTeleport(jobId)
	teleportFailed = false
	local success, err = pcall(function()
		TeleportService:TeleportToPlaceInstance(PLACE_ID, jobId, player)
	end)
	if not success or teleportFailed then
		return false
	end
	return true
end

-- Loop principal
task.spawn(function()
	while true do
		-- Escanea el server actual
		scanServer()

		-- Obtén un server válido
		local nextJob = getNextServer()
		while not nextJob do
			task.wait(HOP_DELAY)
			nextJob = getNextServer()
		end

		-- Teleport seguro
		local teleported = safeTeleport(nextJob)
		while not teleported do
			task.wait(HOP_DELAY)
			nextJob = getNextServer()
			if nextJob then
				teleported = safeTeleport(nextJob)
			end
		end

		-- Espera un instante antes de volver a escanear
		task.wait(0.5)
	end
end)
