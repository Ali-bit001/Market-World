import '../../node_modules/bootstrap/dist/css/bootstrap.min.css';
import './globals.css';
import Providers from '@/components/Providers';
import NavigationProgress from '@/components/NavigationProgress';

export const metadata = {
  title: 'Market World',
  description: 'Real-time economic simulation game',
  icons: {
    icon: '/favicon.svg',
    shortcut: '/favicon.svg',
    apple: '/favicon.svg'
  }
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head />
      <body>
        <Providers>
          <NavigationProgress />
          {children}
        </Providers>
        {/* Bootstrap JS for navbar toggler and interactive components */}
        <script
          src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"
          integrity="sha384-YvpcrYf0tY3lHB60NNkmXc4s9bIOgUxi8T/jzmXoAmOvbmm2z4IlL5PeIYA7vBi"
          crossOrigin="anonymous"
          defer
        />
      </body>
    </html>
  );
}
