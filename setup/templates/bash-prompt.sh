# Explicit opt-in: owns PS1; identity green follows the terminal's ANSI palette.
[ -n "${BASH_VERSION:-}" ] || return 0
case $- in
  *i*) ;;
  *) return 0 ;;
esac
case ${TERM:-} in
  ''|dumb) return 0 ;;
esac

PS1='\[\e[0;39m\][\[\e[32m\]\u@\h\[\e[0;39m\]:\[\e[1m\]\w\[\e[0;39m\]]\$ '
