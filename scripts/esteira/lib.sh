# Subtarefas visíveis nos apps da Esteira (formato ##[esteira-group ...]).
group() { printf '\n##[esteira-group %s %s]\n' "$(date +%s)" "$*"; }
endgroup() { printf '\n##[esteira-endgroup %s]\n' "$(date +%s)"; }
