import { LoginPage } from './auth/LoginPage'
import { AuthProvider, useAuth } from './auth/useAuth'
import { Account } from './leadership/pages/Account'
import { Admin } from './leadership/pages/Admin'
import { Analytics } from './leadership/pages/Analytics'
import { Company } from './leadership/pages/Company'
import { Home } from './leadership/pages/Home'
import { Shell } from './leadership/Shell'
import { LeadershipProvider, useLeadership } from './leadership/state'
import { Skeleton } from './leadership/ui'

function Page() {
  const { route, config, decision, user } = useLeadership()
  if (!decision || (!config.data && !config.error)) return <Skeleton height={420} />
  if (route.view === 'account') return <Account />
  // Company covers every account: users limited to some accounts see Home instead.
  if (route.view === 'company' && (user.role === 'admin' || !user.accounts?.length)) return <Company />
  // Analytics is being reworked: administrators only until it is ready for everyone.
  if (route.view === 'analytics' && user.role === 'admin') return <Analytics />
  if (route.view === 'admin') return <Admin />
  return <Home />
}

function Gate() {
  const { status, user, signOut } = useAuth()
  if (status === 'checking') return <main className="login" aria-busy="true"><Skeleton height={200} /></main>
  if (status === 'signed_out' || !user) return <LoginPage />
  return <LeadershipProvider key={user.username} user={user} signOut={() => { void signOut() }}><Shell><Page /></Shell></LeadershipProvider>
}

export default function App() {
  return <AuthProvider><Gate /></AuthProvider>
}
