<div align="center">

# 🦊 MessagePurger

**Apague ou edite suas próprias mensagens em massa no Discord.**

Plugin para o Vencord, feito por **kiub**

</div>

---

## 📋 O que você precisa instalar antes

| Programa | Download |
| --- | --- |
| **Git** | https://git-scm.com/downloads |
| **Node.js** (versão LTS) | https://nodejs.org |
| **Discord** (versão normal, não a da Microsoft Store) | https://discord.com/download |

Depois de instalar o Node.js, abra o **PowerShell** e instale o pnpm:

```powershell
npm i -g pnpm
```

---

## 🚀 Instalando o Vencord com o plugin

Abra o **PowerShell** e rode os comandos abaixo, um de cada vez.

### 1. Baixe o projeto

```powershell
git clone https://github.com/kiubsat/vencord-personal.git
cd vencord-personal
```

### 2. Instale as dependências

```powershell
pnpm install
```

### 3. Compile

```powershell
pnpm build
```

Espere terminar. Não pode aparecer nenhuma linha vermelha de `ERROR`.

### 4. Instale no Discord

```powershell
pnpm inject
```

Vai aparecer uma lista com as instalações do Discord. Use as setas do teclado para escolher a sua (Stable, PTB ou Canary) e aperte **Enter**.

### 5. Abra o Discord

**Feche o Discord por completo**, inclusive o ícone perto do relógio do Windows, e abra de novo.

---

## ✅ Ativando o plugin

1. No Discord, abra **Configurações** (engrenagem ao lado do seu nome)
2. Role o menu lateral até **Vencord** e clique em **Plugins**
3. Na busca, digite **MessagePurger**
4. Ligue o botão ao lado do plugin

Pronto! Aparece um 🦊 na barra superior do Discord.

---

## 🧭 Como usar

1. Clique com o **botão direito** em uma mensagem **sua**
2. Escolha **Apagar/editar minhas mensagens anteriores**
3. Escolha **Apagar** ou **Editar**, o filtro e o limite (`0` = sem limite)
4. Confirme e acompanhe o progresso pelo painel ou pelo 🦊

> ⚠️ Mensagens apagadas **não podem ser recuperadas**. Use com cuidado.

---

## 🔄 Atualizando

Na pasta `vencord-personal`:

```powershell
git pull origin main
pnpm install
pnpm build
```

Depois aperte `Ctrl + R` no Discord.

---

## 🗑️ Desinstalando

Na pasta `vencord-personal`:

```powershell
pnpm uninject
```

Reinicie o Discord e ele volta ao normal.

---

## 🛠️ Deu problema?

**O plugin não aparece na lista**
- Pesquise por `MessagePurger`
- Rode `pnpm build` de novo e confira se não deu erro
- Rode `pnpm inject` e reinicie o Discord por completo

**Deu erro no `pnpm build`**
- Rode `pnpm install` e tente de novo
- Se continuar, abra uma issue neste repositório com um print do erro

**O Discord foi atualizado e o Vencord sumiu**
- Rode `pnpm inject` de novo e reinicie o Discord

---

<div align="center">

Feito com 🦊 por **kiub**

</div>
