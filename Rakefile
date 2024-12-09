require "yaml"

DRAFTS_DIR = "jekyll/_drafts"
POSTS_DIR  = "jekyll/_posts"

desc "Create a new draft"
task :draft do
  attributes = fetch_attributes(:title, :slug, :categories)
  write_to_file(dir: DRAFTS_DIR, attributes: attributes, layout: "post")
end

desc "Publish a draft"
task :publish do
  draft = select_file(Dir.glob("#{DRAFTS_DIR}/*.md"), "Select a draft to publish")
  next unless draft

  publish_draft(draft)
  puts "Draft published as #{File.join(POSTS_DIR, "#{now}-#{File.basename(draft)}")}"
end

desc "Unpublish a post"
task :unpublish do
  committed_files = `git ls-files #{POSTS_DIR}/*.md`.split("\n")
  uncommitted_posts = Dir.glob("#{POSTS_DIR}/*.md") - committed_files
  post = select_file(uncommitted_posts, "Select a post to unpublish")
  next unless post

  unpublish_post(post)
  puts "Post unpublished as #{File.join(DRAFTS_DIR, unpublish_filename(post))}"
end

# -------------------- Helper Methods --------------------

def fetch_attributes(*keys)
  keys.to_h { |k| [k.to_s, ask("#{k.capitalize}: ")] }
end

def write_to_file(dir:, attributes:, layout: "post")
  slug = attributes.delete("slug")
  attributes["layout"] = layout
  attributes["date"]   = now
  content = YAML.dump(attributes) + "---"
  path = File.join(dir, "#{slug}.md")
  File.write(path, content)
end

def publish_draft(file)
  filename  = File.basename(file)
  new_path  = File.join(POSTS_DIR, "#{now}-#{filename}")
  content   = File.read(file).sub(/^date: .+$/, "date: #{now}")
  File.write(file, content)
  File.rename(file, new_path)
end

def unpublish_post(file)
  new_path = File.join(DRAFTS_DIR, unpublish_filename(file))
  File.rename(file, new_path)
end

def unpublish_filename(file)
  File.basename(file).sub(/^\d{4}-\d{2}-\d{2}-/, "")
end

def now
  Time.now.strftime("%Y-%m-%d")
end

def ask(question)
  STDOUT.print(question)
  STDIN.gets.chomp
end

def select_file(files, prompt)
  file = fzf(files, prompt)
  file unless file.nil? || file.empty?
end

def fzf(files, prompt)
  cmd = ["fzf", "--prompt=#{prompt}: ", "--layout=reverse", "--height=40%"]
  IO.popen(cmd, "r+") do |fzf|
    fzf.puts files
    fzf.close_write
    fzf.gets&.strip
  end
end
