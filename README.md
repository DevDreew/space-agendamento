# DreewSolution · Agendamento para barbearias

App web para celular, tablet e computador.

- **Cliente:** `/nome-da-barbearia` — agenda sem cadastro e acompanha os próprios pedidos (`#meus`). Modo tablet de balcão: `#balcao`.
- **Barbeiro:** `/nome-da-barbearia/painel` — só entra com email e senha. Hoje, Agenda, Clientes, Resultados e Ajustes.
- **Nova barbearia:** `/painel` → Criar conta de barbearia → nome e endereço do link.

## Banco de dados (Supabase)
`supabase/001_schema.sql` cria as tabelas e as regras de acesso:
- `shops`: nome e configuração (vitrine pública, sem dados de clientes). Só o dono altera.
- `bookings`: agendamentos. Só o dono da barbearia lê e altera. O próprio banco impede dois horários sobrepostos no mesmo barbeiro.
- `subscribers`: assinantes do clube. Só o dono.
- Funções públicas para o cliente: `horarios_ocupados` (sem nomes), `pedir_horario` (valida tudo no servidor), `meus_pedidos` e `cancelar_pedido` (pelo código guardado no aparelho do cliente).
