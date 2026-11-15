#!/bin/sh
# Incrémente la version affichée en pied de page : v1.101 -> v1.102, avec la date et l'heure de Paris.
cd "$(dirname "$0")" || exit 1
cur=$(grep -o 'id="ver">v[0-9]*\.[0-9]*' index.html | grep -o '[0-9]*\.[0-9]*$')
maj=${cur%%.*}; min=${cur##*.}; new="$maj.$((min+1))"
when=$(TZ=Europe/Paris date '+%d/%m/%Y à %Hh%M')
sed -i "s|id=\"ver\">v[0-9.]* du [^<]*|id=\"ver\">v$new du $when|" index.html
echo "v$new du $when"
