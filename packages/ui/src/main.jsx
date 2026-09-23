import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import './styles.css'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
)

/**
 * Register the offline shell.
 *
 * Only over https or on localhost, which is all browsers will accept, and
 * never inside the desktop app: that one is served from a custom `app://`
 * scheme where service workers do not apply and the registration would only
 * produce a console error.
 */
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  addEventListener('load', () => {
    navigator.serviceWorker.register(new URL('sw.js', import.meta.url), { scope: './' })
      .catch((err) => console.warn('offline shell unavailable:', err.message))
  })
}
