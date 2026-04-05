use libp2p::SwarmBuilder;
use libp2p::identity;
use libp2p::noise;
use libp2p::yamux;
fn main() {
    let keypair = identity::Keypair::generate_ed25519();
    let builder = SwarmBuilder::with_existing_identity(keypair.clone()).with_tokio();
    let (builder, client) = builder.with_relay_client(noise::Config::new, yamux::Config::default).expect("relay");
}
