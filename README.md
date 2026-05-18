# MyProj

This repository contains a WebRTC-based phone conference application and related utilities.

## Project Structure

```
├── phone-conference/    # WebRTC phone conference application
├── Makefile            # Build configuration
└── test.c              # Test code
```

## Phone Conference Application

A WebRTC phone conference tool built with Node.js and WebSocket. Enables real-time audio/video communication with support for multiple participants in conference rooms.

### Tech Stack

- **Backend**: Node.js with Express.js
- **Communication**: WebSocket (ws)
- **Frontend**: HTML, CSS, JavaScript

### Getting Started

1. Navigate to the phone-conference directory:
   ```bash
   cd phone-conference
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Start the server:
   ```bash
   npm start
   ```
   Or for development with hot reload:
   ```bash
   npm run dev
   ```

4. Open your browser and navigate to `http://localhost:3000`

### Project Files

- `server.js` - WebSocket server and Express backend
- `public/` - Frontend static files
  - `index.html` - Main HTML interface
  - `app.js` - Client-side application logic
  - `style.css` - Styling

## Building

The `Makefile` contains build tasks for the project. Run `make` to see available targets.

## Testing

Test code is available in `test.c`.
