{
  auto_sync = true;
  sync.records = true;
  daemon = {
    enabled = true;
    autostart = true;
  };
  pty_proxy.enabled = true;
  output.enabled = true;
  threads = {
    capture = true;
    capture_tools = true;
  };
}
