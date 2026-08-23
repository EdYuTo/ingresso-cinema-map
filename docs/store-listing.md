# Chrome Web Store — textos prontos (pt-BR)

Copie e cole nos campos do [Developer Dashboard](https://chrome.google.com/webstore/devconsole).

---

## Título

```
Ingresso Cinema Map
```

---

## Resumo curto (máx. 132 caracteres)

```
Mapa de cinemas no ingresso.com: compare distâncias, ordene por proximidade e encontre o cinema ideal para você e seus amigos.
```

*(131 caracteres)*

---

## Descrição detalhada

```
Encontre o cinema mais conveniente sem sair da página do filme no ingresso.com.

O Ingresso Cinema Map embute um mapa interativo diretamente na listagem de sessões. Veja todos os cinemas no mapa, compare distâncias a partir da sua localização e descubra qual sala faz mais sentido para você.

PRINCIPAIS RECURSOS

• Mapa embutido — painel integrado ao layout do ingresso.com, com pins numerados por proximidade
• Ordenação automática — reordena a lista de cinemas da página e mostra a distância em km em cada card
• Localização flexível — use geolocalização, digite um endereço ou cole um link do Google Maps
• Pré-visualização — confirme a posição no mapa antes de aplicar (arraste o marcador para ajustar)
• Restrito à cidade — a busca respeita a cidade selecionada no site
• Modo grupo — adicione endereços de amigos e compare cinemas pelo ponto médio ou por pessoa
• Atualização automática — detecta troca de dia e mudança de cidade na página

COMO USAR

1. Abra um filme em cartaz no ingresso.com
2. O mapa aparece no topo da lista de cinemas
3. Permita a localização ou informe seu endereço manualmente
4. Use os filtros Mais próximo / Mais distante / A–Z
5. Toque em Grupo para comparar cinemas com amigos

PRIVACIDADE

A extensão não envia seus dados para servidores dos desenvolvedores. A localização é usada apenas para calcular distâncias no seu navegador.

Política de privacidade: https://ingresso-cinema-map.pages.dev/privacy.html

Código aberto: https://github.com/EdYuTo/ingresso-cinema-map
```

> **Nota:** Atualize a URL da política de privacidade se você hospedar em outro endereço.

---

## Finalidade única (Single purpose)

```
Melhorar páginas de filme do ingresso.com com um mapa interativo de cinemas e cálculo de distâncias.
```

---

## Justificativas de permissões

Use nos formulários de revisão do Chrome Web Store.

### Permissões da extensão

| Permissão | Justificativa |
|-----------|---------------|
| `activeTab` | Acessar a aba ativa do ingresso.com para exibir o mapa de cinemas. |
| `scripting` | Injetar o painel do mapa e a interface na página do filme. |
| `tabs` | Abrir temporariamente uma aba em segundo plano para resolver links curtos do Google Maps colados pelo usuário. |

### Host permissions

| Host | Justificativa |
|------|---------------|
| `https://www.ingresso.com/*` | Página onde a extensão é exibida e funciona. |
| `https://api-content.ingresso.com/*` | API pública do Ingresso para obter coordenadas dos cinemas. |
| `https://nominatim.openstreetmap.org/*` | Geocodificar endereços digitados pelo usuário. |
| `https://share.google/*`, `https://maps.app.goo.gl/*`, `https://goo.gl/*`, `https://www.google.com/*`, `https://maps.google.com/*` | Resolver links do Google Maps colados pelo usuário na busca de localização. |

---

## Práticas de privacidade (checkboxes)

| Pergunta | Resposta |
|----------|----------|
| Dados pessoalmente identificáveis | **Não** |
| Informações de saúde | **Não** |
| Informações financeiras e de pagamento | **Não** |
| Informações de autenticação | **Não** |
| Comunicações pessoais | **Não** |
| Localização | **Sim** — usada para calcular distâncias; não enviada aos desenvolvedores |
| Histórico de navegação na web | **Não** (acesso limitado às páginas de filme do ingresso.com) |

**Certificação:** marque que o uso de dados está em conformidade com as políticas do programa para desenvolvedores.

**Política de privacidade (URL):**

```
https://ingresso-cinema-map.pages.dev/privacy.html
```

---

## Categoria sugerida

**Compras** ou **Produtividade**

---

## Screenshots sugeridos

Gere com:

```bash
npm run screenshots
```

| Arquivo | Uso |
|---------|-----|
| `website/images/01-map-overview.png` | Principal — visão geral do mapa |
| `website/images/04-cinema-list.png` | Badges de distância nos cards |
| `website/images/06-group-per-friend-map.png` | Modo grupo |

Tamanho recomendado: 1280×800 ou 640×400 px.

---

## Cloudflare Pages (site e política de privacidade)

O site estático fica em `website/` (landing page + privacidade). GitHub Pages não serve aqui: o domínio customizado em `EdYuTo.github.io` redireciona todos os sites para `isonepieceonabreak.com`. Use Cloudflare Pages (grátis, URL própria em `*.pages.dev`).

1. Crie conta em [dash.cloudflare.com](https://dash.cloudflare.com) (se ainda não tiver).
2. **Workers & Pages** → **Create** → **Pages** → **Connect to Git**.
3. Autorize o GitHub e selecione o repositório **`EdYuTo/ingresso-cinema-map`**.
4. Configuração do build (importante — não use Wrangler aqui):
   - **Production branch:** `main`
   - **Framework preset:** None
   - **Build command:** *(deixe vazio)*
   - **Deploy command:** *(deixe vazio — não use `npx wrangler deploy`)*
   - **Build output directory:** `website`
5. **Save and Deploy** — aguarde ~1 minuto.

   **Se o deploy falhar com** `Could not detect a directory containing static files`:
   - Em **Settings → Builds**, apague qualquer **Deploy command** (`npx wrangler deploy` está errado para site estático).
   - Confirme **Build output directory** = `website` e **Build command** vazio.
   - **Retry deployment**.

6. URLs:

   - Landing: `https://ingresso-cinema-map.pages.dev/`
   - Privacidade: `https://ingresso-cinema-map.pages.dev/privacy.html`

   (O subdomínio pode variar se o nome do projeto for diferente — confira em **Deployments** no dashboard.)

7. Abra a URL da política no navegador e confirme que renderiza corretamente antes de colar no Chrome Web Store.

Cada push em `main` que altere `website/` republica automaticamente.
