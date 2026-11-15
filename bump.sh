#!/bin/sh
# Incrémente la version affichée en pied de page : v1.101 -> v1.102, avec la date et l'heure de Paris.
cd "$(dirname "$0")" || exit 1
# Refuse d'incrémenter si le script de la page ne se lit pas (évite de publier un site cassé).
if command -v node >/dev/null 2>&1; then
  python3 -c "s=open('index.html',encoding='utf-8').read();a=s.rfind('<script>')+8;open('/tmp/bonplein-check.js','w',encoding='utf-8').write(s[a:s.rfind('</script>')])" &&
  node --check /tmp/bonplein-check.js || { echo "Erreur de syntaxe dans index.html : version non incrémentée." >&2; exit 1; }
fi
cur=$(grep -o 'id="ver">v[0-9]*\.[0-9]*' index.html | grep -o '[0-9]*\.[0-9]*$')
maj=${cur%%.*}; min=${cur##*.}; new="$maj.$((min+1))"
when=$(TZ=Europe/Paris date '+%d/%m/%Y à %Hh%M')
sed -i "s|id=\"ver\">v[0-9.]* du [^<]*|id=\"ver\">v$new du $when|" index.html
echo "v$new du $when"
