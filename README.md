# Bonplein

Les stations-service autour de vous, de la moins chère à la plus chère : prix en direct, carburants en rupture, stations ouvertes ou fermées, classement par ville.

Un bouton « Classement France » ouvre le podium national : les 3 villes les moins chères et les 3 plus chères de France pour chaque carburant, avec la place de votre ville.

L'application se géolocalise à l'ouverture. Elle est gamifiée : XP, niveaux, badges (dont « Tour de France »), podiums et défi de la semaine. La progression reste sur l'appareil.

**Site :** https://bonplein.paceapp.fr/

## Historique des prix

Chaque lundi, une fonction Supabase (`releve-hebdo`, projet `bonplein`) relève les prix de toutes les stations et prépare les indicateurs (12 dernières semaines par station, moyenne France). Le site ne lit que ces indicateurs déjà calculés : une requête par recherche.

## Compte (facultatif)

Connexion par lien envoyé par e-mail (Supabase Auth, sans mot de passe). Le compte sauvegarde la progression, les réglages et les stations favorites, et permet de recevoir « le point du lundi » par e-mail. Tout le reste fonctionne sans compte. La bibliothèque Supabase (`vendor/supabase.js`) n'est chargée que si l'on se connecte.

## Données

- Prix, ruptures et horaires : flux instantané « Prix des carburants en France » du ministère de l'Économie (prix-carburants.gouv.fr), via l'API data.economie.gouv.fr, actualisé toutes les 10 minutes.
- Adresses et géocodage : Géoplateforme IGN (data.geopf.fr).

Une seule page, `index.html`, sans dépendance ni étape de build.
