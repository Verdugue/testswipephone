# Swipe → PC

Prends une photo sur l'iPhone, glisse-la vers la gauche : elle arrive dans un dossier du PC Windows.

## Lancer

Double-clique `Lancer.bat` (Node.js requis, rien d'autre à installer). Une page s'ouvre sur le PC avec un QR code. Garde la fenêtre noire ouverte tant que tu veux recevoir des photos.

## Sur l'iPhone

1. Scanne le QR code avec l'appareil photo : le lien s'ouvre dans Safari.
2. Partager → « Sur l'écran d'accueil » pour avoir l'icône Swipe comme une appli.
3. Bouton blanc : prendre une photo. Glisser à gauche : envoyer sur le PC. Glisser à droite : ignorer (annulable pendant quelques secondes).
4. L'icône en haut à droite ouvre la galerie pour trier plusieurs photos déjà prises.

L'iPhone et le PC doivent être sur le même réseau, et le serveur doit tourner sur le PC avant d'ouvrir l'appli.

## Réglages

`config.json` est créé au premier lancement :

- `dossier` : où ranger les photos. Dans le chemin, écris les `\` en double (`\\`) ou utilise des `/`.
- `cle` : clé d'appairage contenue dans le QR code. Supprime la ligne pour en générer une nouvelle (il faudra rescanner).

Le port (8765 par défaut) se change avec la variable d'environnement `PORT`.

## Fichiers

- `server.js` : le serveur qui reçoit les photos.
- `public/index.html` : l'appli de l'iPhone.
- `public/pc.html` : la page du PC (QR code et photos reçues en direct).
