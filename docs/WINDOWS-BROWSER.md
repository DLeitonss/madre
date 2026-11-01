# Edge y Chrome de Windows desde MADRE en WSL

Estado: implementación validada con Edge y Chrome reales el 2026-11-01. Veredicto condicional: requiere Node Windows `>=20`; el humano informó que actualizó la máquina probada y obtuvo Node `v26.13.0`, dato no repetido en esta revisión. No se cambió la instalación activa ni la red de Windows/WSL. English: [Windows browser guide](en/WINDOWS-BROWSER.md).

## Preparación explícita en Windows

Requiere Node.js de Windows `>=20` en PATH, interoperabilidad WSL y acceso de Windows a las rutas de la distribución (`wslpath -w`). El servidor se ejecuta en Windows y habla por stdio con MADRE; CDP permanece en `127.0.0.1` de Windows. No necesita acceder por TCP desde WSL al CDP ni cambiar NAT, firewall o `networkingMode`.

El humano ejecuta estas líneas en **PowerShell de Windows**. La instalación descarga paquetes del registro npm; se ejecutó explícitamente durante la validación del 2026-11-01, pero el módulo nunca la automatiza:

```powershell
node.exe -e "const major=Number(process.versions.node.split('.')[0]); if(major<20){throw new Error('MADRE Windows browser requires Node >=20')} console.log(process.version)"
npm.cmd install --prefix "$env:LOCALAPPDATA\MADRE\browser-server" --save-exact @playwright/mcp@0.0.83
```

Se exige exactamente `0.0.83`; el runtime no descarga, actualiza ni busca otro paquete global. `updatePlan` muestra la preparación Windows en vez de instalar Linux. El paquete y sus dependencias quedan en la carpeta indicada, con su lockfile.

Para **Edge**, abre un perfil dedicado que no esté ya abierto:

```powershell
$profileDir = "$env:LOCALAPPDATA\MADRE\browser\msedge"
Start-Process -FilePath 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe' -ArgumentList '--remote-debugging-address=127.0.0.1','--remote-debugging-port=9222',"--user-data-dir=`"$profileDir`"",'about:blank'
```

Para **Chrome**, utiliza otro perfil y otro puerto:

```powershell
$profileDir = "$env:LOCALAPPDATA\MADRE\browser\chrome"
Start-Process -FilePath 'C:\Program Files\Google\Chrome\Application\chrome.exe' -ArgumentList '--remote-debugging-address=127.0.0.1','--remote-debugging-port=9223',"--user-data-dir=`"$profileDir`"",'about:blank'
```

Si tu instalación tiene otra ruta, usa su ejecutable. No uses el perfil personal habitual. Antes de iniciar sesión, verifica que el perfil dedicado no tenga sincronización ni extensiones; elimina de ese perfil cualquier cartera, gestor de contraseñas u otra extensión sensible. Cierra únicamente una ventana anterior del perfil dedicado si necesitas cambiar sus argumentos. No se borran locks ni se cierran otros navegadores automáticamente. El puerto debe estar libre; verifica que el proceso que lo escucha corresponde al perfil dedicado.

En TEST BROWSER selecciona `CONNECTION = windows`, `BROWSER = msedge` o `chrome` y deja `WINDOWS CDP` vacío: Edge usa `9222` y Chrome `9223`. Para otro puerto, escribe `http://127.0.0.1:<port>`. Después enciende el módulo. `WEBSITES` conserva `local`, `youtube` y `all`; el valor inicial es `local`. La conexión inicial del módulo sigue siendo `local`, con `SESSION = isolated`.

## Ventana, sesión, permisos y cierre

El humano abre y cierra el navegador Windows. `SESSION` y `SHOW THE WINDOW` solo controlan la conexión local. En Windows todos los agentes y proyectos que apunten al mismo endpoint comparten pestañas, cookies y cuenta. No hay aislamiento por proyecto ni cola: usa un agente a la vez y abre una pestaña nueva para cada tarea antes de navegar. Inicia sesión personalmente y avisa al agente cuando termines; no se garantiza que Google permita el login.

El diagnóstico consulta únicamente `/json/version`, sin inicializar MCP, navegar, abrir, seleccionar ni cerrar pestañas. Comprueba que Edge/Chrome coincida con la selección y que el WebSocket anunciado sea loopback en el mismo puerto. Esto no verifica la ruta del perfil: compruébala en `edge://version` o `chrome://version`.

El servidor recibe argumentos directos, sin shell, y rutas convertidas por `wslpath`. El puente omite la capacidad MCP `roots` del cliente Linux para que el servidor use el directorio del proyecto convertido a Windows como raíz de trabajo. No comparte raíces adicionales del cliente. Elimina las variables `PLAYWRIGHT_MCP_*`, `NODE_OPTIONS` y `NODE_PATH` heredadas antes de iniciar el proceso Windows y el servidor.

Las capturas **sin nombre de archivo explícito** se guardan en la carpeta del turno mediante la ruta Windows equivalente, incluso cuando es UNC. Los nombres explícitos se resuelven contra la raíz del proyecto, según el servidor fijado; pide capturas sin nombre para mantenerlas en la carpeta del turno. Las respuestas MCP pueden mostrar rutas Windows; usa `wslpath -u '<ruta Windows>'` para localizarlas desde WSL. No se habilita acceso irrestricto a archivos.

Al terminar se cierra stdin del servidor. Si no sale, el worker termina únicamente su proceso Node de MCP. Un heartbeat permite detectar que desapareció el relay WSL y detener ese proceso también; no se usa `taskkill /T` ni se mata el navegador. La prueba real confirmó la conservación de navegador y pestaña con ambos productos. Apagar WSL o el equipo puede interrumpir este cierre.

CDP da control sobre el perfil completo a los procesos locales que accedan al puerto. Los filtros `--allowed-origins` de Playwright no son una frontera de seguridad: no cubren todos los redirects, páginas internas del navegador, pestañas existentes ni toda la consola generada por otras pestañas. `local` reduce navegaciones directas, pero no contiene a un agente hostil. Seleccionar `all` permite tráfico a cualquier web y proveedores de login. Ningún modo permite al agente actuar fuera de la tarea y permisos del humano. No uses esta conexión para aislar una cuenta sensible y no guardes perfiles en Git.

## Diagnóstico y validación

Desde PowerShell, sin navegar pestañas:

```powershell
Invoke-RestMethod http://127.0.0.1:9222/json/version
Invoke-RestMethod http://127.0.0.1:9223/json/version
Get-NetTCPConnection -LocalPort 9222,9223 -State Listen
```

La última salida debe mostrar únicamente direcciones loopback, nunca `0.0.0.0`, `::` ni una interfaz LAN. Si no es así, cierra ese navegador dedicado antes de habilitar el módulo. Las políticas corporativas pueden deshabilitar CDP.

Desde este proyecto en WSL (se ejecuta con `pulse-run` o permiso para programas):

```bash
node --check madre/src/modules/playwright.mjs
node --check madre/src/modules/playwright-windows.mjs
node --test tests/browser.test.mjs tests/browser.domains.test.mjs tests/browser.windows.test.mjs tests/browser.delivery.test.mjs
node madre/src/modules/playwright-windows.mjs probe '{"browser":"msedge"}'
node madre/src/modules/playwright-windows.mjs probe '{"browser":"chrome"}'
node tests/browser.windows.real.mjs
```

Los dos sondeos reales requieren la preparación anterior y no forman parte de las pruebas unitarias. El chequeo de salud lee metadatos; el primer uso de una herramienta sigue siendo la prueba efectiva del servidor MCP.

Resultado real del 2026-11-01: Edge `156.0.4314.50`, Chrome `156.0.8078.74` y `@playwright/mcp@0.0.83` aprobaron handshake/herramientas, navegación a un fixture WSL, bloqueo bajo `local`, acceso bajo `all`, captura PNG accesible desde WSL, conservación de pestaña/cookie entre conexiones, cierre del relay sin cerrar el navegador y sondeo posterior. La prueba terminó con código 0 y las dos capturas se inspeccionaron visualmente.

Validación posterior al arreglo de adaptadores: la conexión Windows entrega al relay únicamente `WSL_DISTRO_NAME` y `WSL_INTEROP`, y Codex configura ese MCP con `required=true`. Con Chrome abierto en el perfil dedicado, turnos reales de Claude y Codex llegaron al fixture local y ambos abrieron una pestaña nueva; resultado 2/2, sin control de rescate para Codex. Edge no se repitió: el proceso abierto no exponía CDP y el perfil observado anteriormente contenía cuenta y extensiones sensibles, por lo que se dejó intacto hasta que el humano lo limpie. La instalación activa de MADRE aún no recibió el parche.

La aparente intermitencia de `browser.login` era una medición defectuosa: al reabrir, Chromium podía servir el documento desde caché, pero la prueba descartaba las cabeceras de los heartbeats y comprobaba la cookie antes del siguiente. La prueba ahora observa todas las peticiones y espera la cookie; pasó 6/6 aislada y una corrida dentro de la suite completa. La suite local quedó en 112 aprobadas, 3 límites conocidos marcados `TODO` y 0 fallos. `npm test` y `npm run pack:check` siguen sin poder ejecutarse en esta copia parcial porque faltan `madre/test/setup.mjs` y `madre/scripts/pack-check.mjs`.

La ejecución también descubrió que Node Windows `18.17.0` permitía el sondeo pero fallaba en el primer RPC: las dependencias instaladas requieren Node `>=20`. El puente ahora comprueba la versión antes de iniciar el servidor y muestra la versión incompatible. El humano informó después que el Node global devolvía `v26.13.0`; esta revisión no repitió esa medición. `tests/browser.windows.real.mjs` presupone que el Node adecuado ya está en el PATH de Windows y deja abiertas las pestañas del perfil dedicado para comprobar persistencia.

Quedan con el humano el reinicio/uso desde la instalación activa, la verificación visual del perfil en `edge://version`/`chrome://version` y un login real. Si Windows no llega a un servidor WSL por localhost, resuelve primero ese acceso; este puente no cambia la red.

Fuentes: [opciones y límites de Playwright MCP](https://github.com/microsoft/playwright-mcp/tree/v0.0.83), [metadatos de la versión fijada](https://github.com/microsoft/playwright-mcp/blob/v0.0.83/package.json), [endpoint de diagnóstico de Edge](https://learn.microsoft.com/en-us/microsoft-edge/devtools/protocol/#jsonversion).
