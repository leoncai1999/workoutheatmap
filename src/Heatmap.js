import React, { Component } from 'react';
import { Map, GoogleApiWrapper, Polyline } from 'google-maps-react';
import axios from 'axios';
import * as keys from './APIKeys';
import { Button, Dropdown } from 'react-bootstrap';
import Welcome from './Welcome';
import './Heatmap.css';

const mapStyles = {
  width: '100%',
  height: '100%'
};

class Heatmap extends Component {

  state = {
    activities: [],
    polylines: [{"id" : 0, "type" : "All", "polylines" : []}],
    activity_type: 0,
    access_token: '',
    map_center: {},
    cities: [],
    zoom: 4
  };

  async componentDidMount() {

    const access_token = await this.updateAccessToken(String(window.location.href))

    // Revert the url of the site to the default url after authentication is finished
    window.history.pushState({}, null, 'http://localhost:3000/workout-heatmap')

    var user_activities = []
    var user_polylines = [{"id" : 0, "type" : "All", "polylines" : []}]

    var activities_left = true
    var page_num = 1;

    if (access_token !== '') {
      this.setState({ access_token })

      while (activities_left) {
        // Retrieve Strava Activites in batches of 200 until no activities are left
        const activities = await this.getActivities(page_num, access_token)
  
        if (activities.length === 0) {
          activities_left = false
        } else {
          const decodePolyline = require('decode-google-map-polyline')
  
          for (let i = 0; i < activities.length; i++) {
            user_activities.push(activities[i])
  
            var polyline = activities[i]['map']['summary_polyline']
            if (polyline != null) {
              user_polylines[0]["polylines"].push(decodePolyline(polyline))

              // Store all polylines grouped by each type of activity
              var unique_activity_type = true
              var type_num = 1

              while (unique_activity_type && type_num < user_polylines.length) {
                if (user_polylines[type_num]["type"] === activities[i].type) {
                  user_polylines[type_num]["polylines"].push(decodePolyline(polyline))
                  unique_activity_type = false
                } else {
                  type_num += 1
                }
              }

              if (unique_activity_type) {
                user_polylines.push({'id' : user_polylines.length, 'type' : activities[i].type, 'polylines' : [decodePolyline(polyline)]})
              }
            }
          }
  
          this.setState({ activities : user_activities})
          this.setState({ polylines : user_polylines})
          page_num += 1
        }
      }

      const cities = await this.getCitiesFromActivites(user_activities)
      const city_counts = this.getCityActivityCounts(cities, user_activities)

      this.setState({ cities: city_counts })

      if (city_counts.length !== 0) {
        this.recenterMap(0)
      } else {
        // Default location is geographic center of the U.S.
        this.setState( { map_center : { lat: 39.8283, lng: -98.5795 }} )
      }
    }
  }

  getCitiesFromActivites = async(user_activities) => {

    var message_bodies = []
    var curr_message_body = ''
    var activity_num = 1

    // format activity coordinates into batches of 100 for the Reverse Geocoding API
    for (let i = 0; i < user_activities.length; i++) {
      let activity_cords = user_activities[i].start_latlng
      if (activity_cords !== null) {
        let curr_message = 'id=' + activity_num + '&prox=' + activity_cords[0] + ',' + activity_cords[1] + ',500\n'
        curr_message_body += curr_message

        if (activity_num === 100) {
          activity_num = 1
          message_bodies.push(curr_message_body)
          curr_message_body = ''
        } else {
          activity_num += 1
        }
      }
    }

    const options = {
      'Content-Type': '*',
      'Cache-Control': 'no-cache'
    }

    const proxy_url = "https://cors-anywhere.herokuapp.com/"
    const api_url = "https://reverse.geocoder.ls.hereapi.com/6.2/multi-reversegeocode.json?mode=retrieveAreas&apiKey=" + keys.HERE_API_KEY

    var all_results = []

    for (let i = 0; i < message_bodies.length; i++) {
      let results = await axios
        .post(proxy_url + api_url, message_bodies[i], { headers: options })

      Array.prototype.push.apply(all_results, results.data.Response.Item)
    }

    return all_results
  }

  getCityActivityCounts = (cities, user_activities) => {
    var city_counts = []
    var last_activity_with_location = 0

    // need to account for other countries where State may be null
    for (let i = 0; i < cities.length; i++) {
      let address = cities[i].Result[0].Location.Address
      let city_name = address.City + ", " + address.State

      // Map the geocoding information of an activity to it's Strava details
      let lat = cities[i].Result[0].Location.DisplayPosition.Latitude
      let lng = cities[i].Result[0].Location.DisplayPosition.Longitude

      var activity = {}
      var activity_found = false
      var x = last_activity_with_location

      while (!activity_found) {
        let curr_activity = user_activities[x]
        if (curr_activity["start_latitude"] === lat && curr_activity["start_longitude"] === lng) {
          activity_found = true
          activity = curr_activity
          last_activity_with_location = x + 1
        } else {
          x += 1
        }
      }

      let activity_miles = activity["distance"] / 1609

      var unique_city = true
      var city_num = 0

      while (unique_city && city_num < city_counts.length) {
        if (city_counts[city_num]["city"] === city_name) {
          city_counts[city_num]["activities"] += 1
          city_counts[city_num]["miles"] += activity_miles
          unique_city = false
        } else {
          city_num += 1
        }
      }

      if (unique_city) {
        city_counts.push({'city' : city_name, 'activities' : 1, 'miles' : activity_miles })
      } 

    }

    // Sort cities by number of activites descending, breaking ties by total mileage
    city_counts.sort(function(a,b) {
      return b.activities - a.activities || b.miles - a.miles
    })

    for (let i = 0; i < city_counts.length; i++) {
      city_counts[i]["id"] = i
    }

    return city_counts
  }

  getActivities = async(page_num, access_token) => {
    var invalid_token = false

    let results = await axios
      .get("https://www.strava.com/api/v3/athlete/activities?", {
        params: {
          per_page: '200',
          page: page_num,
          access_token: access_token
        }
      }).catch(error => {
        invalid_token = true
      })

    return invalid_token ? [] : results.data
  }

  updateAccessToken = async(url) => {
    var token = ''

    // Retrieve the code from the authenication process, then exchange the code for a token to access the Strava API
    const tokenized_url = url.split('/')
    if (tokenized_url[4] !== null && tokenized_url[4].substring(0,8) === 'callback') {
        let code_and_scope = tokenized_url[4].substring(27);
        let code = code_and_scope.substring(0, code_and_scope.indexOf('&'))

        let results = await axios
            .post("https://www.strava.com/api/v3/oauth/token?", {
                client_id: '27965',
                client_secret: keys.STRAVA_SECRET,
                code: code,
                grant_type: 'authorization_code'
        })

        token = results.data.access_token
    }

    return token
  }

  recenterMap = async(city_id) => {
    // Store coordinates of cities at first request to avoid excess API calls
    if (!("cords" in this.state.cities[city_id])) {
      let api_url = 'https://api.mapbox.com/geocoding/v5/mapbox.places/' + this.state.cities[city_id]["city"] + ".json?"
      let result = await axios
      .get(api_url, {
        params: {
          access_token: keys.GEOCODING_API_KEY
        }
      })

      let cords = result.data.features[0]
      let center_cords = { lat: cords.center[1], lng: cords.center[0]}

      let city_counts = this.state.cities
      city_counts[city_id]["cords"] = center_cords

      this.setState({ cities : city_counts})
    }

    this.setState({ map_center: this.state.cities[city_id]["cords"] })
    this.setState({ zoom : 13 })
  }

  render() {

    if (this.state.access_token === '') {
      return (
        <div>
          <Welcome />
        </div>
      )
    } else {
      return (
        <div id="container">
  
            <div id="map">
              <Map
                google={this.props.google}
                zoom={this.state.zoom} 
                style={mapStyles}
                initialCenter={ { lat: 39.8283, lng: -98.5795 } }
                center={this.state.map_center}
                ref={(ref) => { this.map = ref; }}
              >
                {this.state.polylines[this.state.activity_type]["polylines"].map(polyline => {
                  return (
                    <Polyline
                        path={polyline}
                        strokeColor='#6F1BC6'
                        strokeWeight='2'
                    />
                  )
                })}
              </Map>
            </div>

            <div id="cities-search">
              <Dropdown>
                <Dropdown.Toggle>
                  Select City
                </Dropdown.Toggle>
                <Dropdown.Menu>
                  {this.state.cities.map(city => {
                    let description = city["city"] + ": " + city["activities"] + " Activites, " + city["miles"].toFixed(2) + " Miles"
                    return (
                      <Dropdown.Item
                        onClick={() => {
                          this.recenterMap(city["id"])
                        }}
                      >
                        {description}
                      </Dropdown.Item>
                    )
                  })}
                </Dropdown.Menu>
              </Dropdown>
            </div>

            <div id="map-menu">
              Options
              <br></br>
              {this.state.polylines.map(activity_type => {
                return (
                  <Button onClick={(e) => { this.setState({ activity_type : activity_type["id"] }) }}>
                    {activity_type["type"]}
                  </Button>
                )
              })}
            </div>
  
        </div>
      )
    } 
  }
}

export default GoogleApiWrapper({
  apiKey: keys.GOOGLE_MAPS_API_KEY
})(Heatmap);