$ErrorActionPreference = "Continue"
$brush = "D:\AI\ui-remove\DiffuEraser\weights\diffuEraser\brushnet\diffusion_pytorch_model.safetensors"
$unet = "D:\AI\ui-remove\DiffuEraser\weights\diffuEraser\unet_main\diffusion_pytorch_model.safetensors"
$blog = "D:\AI\ui-remove\DiffuEraser\weights\diffuEraser\brushnet\resume.err.log"
Start-Process -WindowStyle Hidden -FilePath curl.exe -ArgumentList @("-L","--retry","5","-C","-","-o",$brush,"https://huggingface.co/lixiaowen/diffuEraser/resolve/main/brushnet/diffusion_pytorch_model.safetensors") -RedirectStandardError $blog
$brushTarget = 3544367048
$unetTarget = 5253497856
for ($i = 0; $i -lt 48; $i++) {
  Start-Sleep -Seconds 15
  $b = (Get-Item -LiteralPath $brush).Length
  $u = (Get-Item -LiteralPath $unet).Length
  Write-Output ("t=" + $i + " brush=" + $b + "/" + $brushTarget + " unet=" + $u + "/" + $unetTarget)
  if ($b -ge $brushTarget -and $u -ge $unetTarget) { break }
}
Write-Output "DONE_POLL"