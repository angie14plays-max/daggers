if not game:IsLoaded() then game.Loaded:Wait() end
task.wait(1)

-- cargar scanner y hopper
task.spawn(function()
    loadstring(game:HttpGet("https://raw.githubusercontent.com/TU_USUARIO/TU_REPO/main/scanner.lua"))()
end)
task.spawn(function()
    loadstring(game:HttpGet("https://raw.githubusercontent.com/TU_USUARIO/TU_REPO/main/hopper.lua"))()
end)
