$login = Invoke-RestMethod -Uri 'https://redbackend.fly.dev/api/auth/login' -Method Post -ContentType 'application/json' -Body (ConvertTo-Json @{ email='testuser+ai@example.com'; password='secret123' } -Depth 5)
$token = $login.data.access_token
Write-Output "TOKEN_LEN: $($token.Length)"
$body = ConvertTo-Json @{ tenant = @{ nome='Local Tenant X'; tipo='restaurante' } } -Depth 5
Invoke-RestMethod -Uri 'http://127.0.0.1:7860/api/auth/register-tenant' -Method Post -ContentType 'application/json' -Headers @{ Authorization = "Bearer $token" } -Body $body | ConvertTo-Json -Depth 6
