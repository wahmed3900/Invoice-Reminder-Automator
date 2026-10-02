// RECONSTRUCTED — this file was referenced by server.js but missing from the
// uploaded repo. Best-guess implementation inferred from its call sites:
//   const { passport, issueToken, requireAuth } = require('./src/middleware/auth');
//   passport.authenticate('google', { scope: [...], session: false })
//   issueToken(req.user) -> JWT string, read back as req.user.userId in every route
//   requireAuth -> Express middleware gating every /api/* route
const passport = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const jwt = require('jsonwebtoken');
const prisma = require('../lib/prisma');

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: process.env.GOOGLE_CALLBACK_URL || '/auth/google/callback',
      },
      async (_accessToken, _refreshToken, profile, done) => {
        try {
          const email = profile.emails?.[0]?.value;
          const picture = profile.photos?.[0]?.value;
          if (!email) return done(new Error('Google account has no email'));

          // One row per Google account: match by googleId first, fall back to
          // email (covers a user who existed before Google login was added),
          // then create.
          let user = await prisma.user.findUnique({ where: { googleId: profile.id } });
          if (!user) {
            user = await prisma.user.upsert({
              where: { email },
              update: { googleId: profile.id, name: profile.displayName, picture },
              create: {
                email,
                googleId: profile.id,
                name: profile.displayName,
                picture,
                subscription: 'FREE',
              },
            });
          }
          done(null, user);
        } catch (err) {
          done(err);
        }
      }
    )
  );
} else {
  console.warn('[auth] GOOGLE_CLIENT_ID/SECRET not set — Google login routes will fail until configured');
}

function issueToken(user) {
  if (!JWT_SECRET) throw new Error('JWT_SECRET not configured');
  // subscription is NOT trusted from this token anywhere downstream — every
  // plan check re-reads it from the database (see src/middleware/subscription.js).
  return jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  if (!JWT_SECRET) return res.status(500).json({ error: 'Auth is not configured' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = { passport, issueToken, requireAuth };
