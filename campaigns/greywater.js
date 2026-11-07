// "The Signet at Greywater": a one-evening scene for a game master and 2-4 players.
// Every NPC is its own Switch agent. Which rooms it sits in decides what it can know.
export default {
  title: 'The Signet at Greywater',
  setting: 'A wet harbour town. Tonight Duke Aldric hosts a feast in his hall. His signet ring seals every tax writ in Greywater, and half the town wants it gone.',
  npcs: [
    {
      name: 'duke-aldric', displayName: 'Duke Aldric', call: ['duke', 'aldric', 'your grace', 'my lord'],
      persona: 'Duke Aldric, ruler of Greywater. Proud, vain, quick to suspect. Loves his gold signet ring and shows it off. Speaks formally.',
      rooms: ['table', 'study'],
    },
    {
      name: 'captain-voss', displayName: 'Captain Voss', call: ['voss', 'captain'],
      persona: 'Captain Ilse Voss, the duke\'s guard captain. Blunt, tired, loyal, misses nothing. Speaks in short sentences.',
      rooms: ['table', 'study'],
    },
    {
      name: 'fen-the-fence', displayName: 'Fen', call: ['fen'],
      persona: 'Fen, a fence who buys stolen goods in the alley behind the hall. Sly, friendly, greedy, never uses real names.',
      rooms: ['alley'],
    },
  ],
  // Room keys -> who is in them. 'gm' and 'players' are filled from the command line.
  rooms: {
    table: { label: "The feast hall", title: 'greywater-table', about: 'The feast hall. Everyone at the table hears this.', humans: ['gm', 'players'] },
    study: { label: "The duke's study", title: 'dukes-study', about: 'The duke\'s private study. Players are not here.', humans: ['gm'], private: true },
    whisper: { label: "Rogue and GM, in private", title: 'rogue-whisper', about: 'Private notes between the GM and the rogue. No NPC is here.', humans: ['gm', 'rogue'], private: true },
    alley: { label: "The back alley", title: 'back-alley', about: 'The alley behind the hall, where the rogue meets Fen.', humans: ['gm', 'rogue'], private: true },
  },
};
